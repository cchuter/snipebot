#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { io } = require('socket.io-client');
const { GSwap, PrivateKeySigner } = require('@gala-chain/gswap-sdk');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, 'snipebot.log');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

const WS_URL = process.env.GALA_BUNDLE_WS || 'wss://bundle-backend-prod1.defi.gala.com';
const BUY_AMOUNT = process.env.BUY_AMOUNT || '50';
const BASE_TOKEN = process.env.BASE_TOKEN || 'GALA|Unit|none|none';
const SLIPPAGE = Number.isFinite(parseFloat(process.env.SLIPPAGE))
  ? parseFloat(process.env.SLIPPAGE)
  : 0.98;
const RETRY_BASE_MS = Number.isFinite(parseInt(process.env.RETRY_BASE_MS, 10))
  ? parseInt(process.env.RETRY_BASE_MS, 10)
  : 250;
const RETRY_MAX_MS = Number.isFinite(parseInt(process.env.RETRY_MAX_MS, 10))
  ? parseInt(process.env.RETRY_MAX_MS, 10)
  : 6000;

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

if (!WALLET_PRIVATE_KEY || !WALLET_ADDRESS) {
  console.error('WALLET_PRIVATE_KEY and WALLET_ADDRESS must be set in .env');
  process.exit(1);
}

const signer = new PrivateKeySigner(WALLET_PRIVATE_KEY);
const gSwap = new GSwap({ signer });

function writeLog(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logStream.write(`${line}\n`);
  console.log(line);
}

function writeError(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  logStream.write(`${line}\n`);
  console.error(line);
}

function ensureBlacklist() {
  const blacklistPath = path.resolve(__dirname, '..', 'blacklist.csv');
  if (!fs.existsSync(blacklistPath)) {
    fs.writeFileSync(blacklistPath, 'address\n', 'utf8');
  }
  return blacklistPath;
}

function normalizeAddress(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.includes('|')) return trimmed.toLowerCase();
  if (trimmed.includes(':')) {
    const [prefix, ...rest] = trimmed.split(':');
    return `${prefix}|${rest.join(':')}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

function loadBlacklist() {
  const blacklistPath = ensureBlacklist();
  const entries = fs.readFileSync(blacklistPath, 'utf8').split(/\r?\n/);
  const set = new Set();
  entries.slice(1).forEach((line) => {
    const normalized = normalizeAddress(line);
    if (normalized) set.add(normalized);
  });
  return set;
}

function symbolFromVault(vaultAddress) {
  const match = vaultAddress?.match(/Token\$Unit\$([^$]+)\$/);
  return match ? match[1] : null;
}

function tokenFromVault(vaultAddress) {
  const match = vaultAddress?.match(/^service\|Token\$Unit\$([^$]+)\$([^$]+)\$launchpad$/);
  if (!match) return null;
  return `Token|Unit|${match[1]}|${match[2]}`;
}

function addressFromVault(vaultAddress) {
  const match = vaultAddress?.match(/\$([a-z0-9:]+)\$launchpad$/i);
  return match ? normalizeAddress(match[1]) : null;
}

function candidateFromData(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = (obj.functionName || obj.FunctionName || '').toString().toLowerCase();
  const isCreate = fn === 'createsale' || obj.initialBuyQuantity !== undefined;
  if (!isCreate) return null;
  const vaultAddress = obj.vaultAddress || obj.vault || obj.vaultaddress;
  if (!vaultAddress || !vaultAddress.toLowerCase().includes('launchpad')) return null;
  const symbol =
    obj.symbol ||
    obj.type ||
    (obj.tokenStringKey ? obj.tokenStringKey.split('$')[2] : null) ||
    symbolFromVault(vaultAddress);
  const tokenName = obj.tokenName || obj.name || obj.token || symbol || 'unknown';
  const creatorAddress = obj.creatorAddress || obj.creator || obj.ownerAddress || obj.owner;
  const additionalKey =
    obj.additionalKey ||
    obj.tokenAdditionalKey ||
    (obj.tokenStringKey ? obj.tokenStringKey.split('$')[3] : null);
  return { tokenName, symbol, vaultAddress, creatorAddress, additionalKey };
}

function extractCreateSale(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const direct = candidateFromData(payload);
  if (direct) return direct;

  if (payload.data && typeof payload.data === 'object') {
    const nested = candidateFromData(payload.data);
    if (nested) return nested;
    if (payload.data.Data && typeof payload.data.Data === 'object') {
      const deep = candidateFromData(payload.data.Data);
      if (deep) return deep;
    }
  }

  if (payload.Data && typeof payload.Data === 'object') {
    const nested = candidateFromData(payload.Data);
    if (nested) return nested;
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const blacklist = loadBlacklist();
const trackedVaults = new Map();

async function waitForQuote(targetToken, label) {
  let attempt = 0;
  // Keep retrying until a quote is available (pool exists).
  // Errors are squelched to avoid noisy logs.
  for (;;) {
    attempt += 1;
    try {
      const quote = await gSwap.quoting.quoteExactInput(BASE_TOKEN, targetToken, BUY_AMOUNT);
      return quote;
    } catch (err) {
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      writeLog(`Pool not ready for ${label}; retry ${attempt} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function executeBuy(token) {
  const targetToken = tokenFromVault(token.vaultAddress);
  if (!targetToken) {
    writeError(`Cannot derive token from vault ${token.vaultAddress}; skipping buy.`);
    return;
  }

  const label = `${token.symbol || symbolFromVault(token.vaultAddress) || token.tokenName || 'token'}`;
  writeLog(`🆕 CreateSale detected for ${label} (${token.vaultAddress})`);

  const blacklistHit = [token.creatorAddress, token.additionalKey, addressFromVault(token.vaultAddress)]
    .map((value) => normalizeAddress(value))
    .find((value) => value && blacklist.has(value));

  if (blacklistHit) {
    writeLog(`⏭️ Skipping ${label} due to blacklist match (${blacklistHit})`);
    return;
  }

  if (trackedVaults.has(token.vaultAddress)) {
    writeLog(`Already handling ${label}; ignoring duplicate event.`);
    return;
  }

  trackedVaults.set(token.vaultAddress, 'pending');

  try {
    writeLog(
      `🔍 Waiting for pool | base=${BASE_TOKEN} -> target=${targetToken} | buy=${BUY_AMOUNT} | slippage=${SLIPPAGE}`,
    );
    const quote = await waitForQuote(targetToken, label);
    const minOut = quote.outTokenAmount.multipliedBy(SLIPPAGE);
    writeLog(
      `🚀 Buying ${BUY_AMOUNT} of ${label} at fee ${quote.feeTier}; minOut=${minOut.toString()}`,
    );
    const pendingTx = await gSwap.swaps.swap(
      BASE_TOKEN,
      targetToken,
      quote.feeTier,
      { exactIn: BUY_AMOUNT, amountOutMinimum: minOut },
      WALLET_ADDRESS,
    );
    writeLog(`✅ Swap submitted for ${label} | txId=${pendingTx.transactionId}`);
    try {
      const receipt = await pendingTx.wait();
      writeLog(`📦 Confirmed ${label} | hash=${receipt.transactionHash}`);
    } catch (waitErr) {
      writeError(`Wait for ${label} confirmation failed: ${waitErr?.message || waitErr}`);
    }
  } catch (err) {
    writeError(`Swap failed for ${label}: ${err?.message || err}`);
  } finally {
    trackedVaults.delete(token.vaultAddress);
  }
}

async function walkPayload(payload, eventName, visited = new WeakSet()) {
  if (payload === null || payload === undefined) return;

  if (typeof payload !== 'object') return;
  if (visited.has(payload)) return;
  visited.add(payload);

  const candidate = extractCreateSale(payload);
  if (candidate) {
    // Fire-and-forget so we don't block processing of subsequent websocket messages.
    executeBuy(candidate).catch((err) => {
      writeError(`Unhandled error processing ${eventName || 'event'}: ${err?.message || err}`);
    });
    return;
  }

  for (const value of Object.values(payload)) {
    // eslint-disable-next-line no-await-in-loop
    await walkPayload(value, eventName, visited);
  }
}

function handleShutdown(signal, socket) {
  writeLog(`Received ${signal}, shutting down snipebot.`);
  socket.close();
  logStream.end(() => {
    process.exit(0);
  });
}

function main() {
  writeLog(
    `Starting snipebot | ws=${WS_URL} | base=${BASE_TOKEN} | buy=${BUY_AMOUNT} | slippage=${SLIPPAGE}`,
  );
  writeLog(`Logging to ${path.relative(process.cwd(), LOG_PATH)}`);
  writeLog(`Loaded ${blacklist.size} blacklist entries`);

  const socket = io(WS_URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    writeLog(`Connected to ${WS_URL} (${socket.id})`);
  });

  socket.on('disconnect', (reason) => {
    writeLog(`Disconnected: ${reason}`);
  });

  socket.on('connect_error', (err) => {
    writeError(`Connection error: ${err.message}`);
  });

  socket.onAny(async (event, ...args) => {
    for (const arg of args) {
      // eslint-disable-next-line no-await-in-loop
      await walkPayload(arg, event);
    }
  });

  process.on('SIGINT', () => handleShutdown('SIGINT', socket));
  process.on('SIGTERM', () => handleShutdown('SIGTERM', socket));
}

main();
