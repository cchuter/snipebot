#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const { io } = require('socket.io-client');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_PATH = path.join(LOG_DIR, 'snipebot.log');
const TOKENS_BOUGHT_PATH = path.resolve(__dirname, '..', 'tokens_bought.csv');
const BUY_SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'buy_launchpad_token.js');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

const WS_URL = process.env.GALA_BUNDLE_WS || 'wss://bundle-backend-prod1.defi.gala.com';
const BUY_AMOUNT = process.env.BUY_AMOUNT || '50';
const SLIPPAGE = Number.isFinite(parseFloat(process.env.SLIPPAGE))
  ? parseFloat(process.env.SLIPPAGE)
  : 0.05;
const DEFAULT_DELAY_MS = 60000;
const delayOverride = process.env.SNIPEBOT_DELAY_MS || process.env.SNIPEBOT_DELAY_SECONDS;
const BUY_DELAY_MS = Number.isFinite(parseInt(delayOverride, 10))
  ? parseInt(delayOverride, 10)
  : DEFAULT_DELAY_MS;
const RETRY_BASE_MS = Number.isFinite(parseInt(process.env.RETRY_BASE_MS, 10))
  ? parseInt(process.env.RETRY_BASE_MS, 10)
  : 250;
const RETRY_MAX_MS = Number.isFinite(parseInt(process.env.RETRY_MAX_MS, 10))
  ? parseInt(process.env.RETRY_MAX_MS, 10)
  : 6000;
const RETRY_MAX_ATTEMPTS = Number.isFinite(parseInt(process.env.RETRY_MAX_ATTEMPTS, 10))
  ? parseInt(process.env.RETRY_MAX_ATTEMPTS, 10)
  : 20;
const DEBUG =
  (process.env.SNIPEBOT_DEBUG || '').toString().toLowerCase() === 'true' ||
  process.env.SNIPEBOT_DEBUG === '1';

const WALLET_PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;

if (!WALLET_PRIVATE_KEY) {
  console.error('WALLET_PRIVATE_KEY must be set in .env');
  process.exit(1);
}

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

function ensureTokensBoughtCsv() {
  if (!fs.existsSync(TOKENS_BOUGHT_PATH)) {
    fs.writeFileSync(TOKENS_BOUGHT_PATH, 'tokenName,symbol,vaultAddress,txId,buyAmount\n', 'utf8');
  }
}

function recordBoughtToken({ tokenName, symbol, vaultAddress }, txId) {
  ensureTokensBoughtCsv();
  const safeName = (tokenName || '').replace(/,/g, ' ');
  const safeSymbol = (symbol || '').replace(/,/g, ' ');
  const safeVault = (vaultAddress || '').replace(/,/g, ' ');
  const safeTx = (txId || '').replace(/,/g, ' ');
  fs.appendFileSync(
    TOKENS_BOUGHT_PATH,
    `${safeName},${safeSymbol},${safeVault},${safeTx},${BUY_AMOUNT}\n`,
    'utf8',
  );
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

function parseTxId(output) {
  const match = output.match(/transactionId['"?:=\\s]+([\\w-]+)/i) || output.match(/txId['"?:=\\s]+([\\w-]+)/i);
  return match ? match[1] : null;
}

function parseTxIdLoosely(output) {
  if (!output) return null;
  const txMatch = output.match(/transactionId['"?:=\\s]+([0-9a-fA-F-]{8,})/i);
  if (txMatch) return txMatch[1];
  const generic = output.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
  return generic ? generic[1] : null;
}

function shouldSuppressLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const noisyPatterns = [/AxiosError/i, /node:/, /internal\//, /at .*\.js:\d/, /MODULE_NOT_FOUND/];
  return noisyPatterns.some((re) => re.test(trimmed));
}

function extractPoolNotFound(line) {
  if (line.toLowerCase().includes('pool not found')) {
    return 'Pool not found with the given parameters';
  }
  return null;
}

async function executeBuy(token) {
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

  const tokenArg = token.symbol || token.tokenName || symbolFromVault(token.vaultAddress);
  if (!tokenArg) {
    writeError(`Cannot resolve token name for ${token.vaultAddress}; skipping buy.`);
    trackedVaults.delete(token.vaultAddress);
    return;
  }

  if (!fs.existsSync(BUY_SCRIPT_PATH)) {
    writeError(`Buy script missing at ${BUY_SCRIPT_PATH}; cannot execute buy.`);
    trackedVaults.delete(token.vaultAddress);
    return;
  }

  writeLog(`🚀 Spawning launchpad buy: node ${path.relative(process.cwd(), BUY_SCRIPT_PATH)} ${tokenArg} ${BUY_AMOUNT} ${SLIPPAGE}`);

  if (BUY_DELAY_MS > 0) {
    writeLog(`⏱️ Delaying buy execution by ${BUY_DELAY_MS}ms`);
    await sleep(BUY_DELAY_MS);
  }

  let attempt = 0;
  let succeeded = false;
  let lastErrorSummary = null;
  let lastTxId = null;
  let sawSubmission = false;

  while (!succeeded && attempt < RETRY_MAX_ATTEMPTS) {
    attempt += 1;
    lastErrorSummary = null;
    sawSubmission = false;
    const child = spawn(process.execPath, [BUY_SCRIPT_PATH, tokenArg, BUY_AMOUNT, SLIPPAGE], {
      env: {
        ...process.env,
        WALLET_PRIVATE_KEY,
        LAUNCHPAD_VAULT_ADDRESS: token.vaultAddress || process.env.LAUNCHPAD_VAULT_ADDRESS,
        LAUNCHPAD_TOKEN_NAME: tokenArg,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let poolErrorLogged = false;

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      text.split(/\r?\n/).forEach((line) => {
        if (!line.trim()) return;
        if (!DEBUG && shouldSuppressLine(line)) return;
        if (line.toLowerCase().includes('transactionid')) {
          writeLog(`[buy stdout] ${line.trim()}`);
          const tx = parseTxId(line);
          if (tx) {
            lastTxId = tx;
          }
        } else if (line.toLowerCase().includes('buy submitted')) {
          sawSubmission = true;
          writeLog(`[buy stdout] ${line.trim()}`);
        } else if (DEBUG) {
          writeLog(`[buy stdout] ${line.trim()}`);
        }
      });
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      text.split(/\r?\n/).forEach((line) => {
        const poolMsg = extractPoolNotFound(line);
        if (poolMsg && !poolErrorLogged) {
          lastErrorSummary = poolMsg;
          poolErrorLogged = true;
          writeLog(`[buy stderr] ${poolMsg}`);
        } else if (DEBUG && line.trim()) {
          writeError(`[buy stderr] ${line.trim()}`);
        }
      });
    });

    // eslint-disable-next-line no-await-in-loop
    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
    });

    const txId = lastTxId || parseTxId(output) || parseTxIdLoosely(output);

    if (txId || sawSubmission) {
      const finalTxId = txId || '';
      writeLog(`✅ Launchpad buy exited ${exitCode}${finalTxId ? ` | txId=${finalTxId}` : ''}`);
      recordBoughtToken(token, finalTxId);
      succeeded = true;
      break;
    }

    if (exitCode === 0) {
      writeLog(`✅ Launchpad buy exited 0 (no txId captured)`);
      recordBoughtToken(token, '');
      succeeded = true;
      break;
    }

    const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const reason = lastErrorSummary || 'buy script failed';
    if (attempt < RETRY_MAX_ATTEMPTS) {
      writeLog(`⚠️ ${reason}; retry ${attempt}/${RETRY_MAX_ATTEMPTS} in ${delay}ms`);
      // eslint-disable-next-line no-await-in-loop
      await sleep(delay);
    } else {
      writeError(`❌ Launchpad buy failed after ${attempt} attempts: ${reason}`);
    }
  }

  trackedVaults.delete(token.vaultAddress);
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
    `Starting snipebot | ws=${WS_URL} | buy=${BUY_AMOUNT} | slippage=${SLIPPAGE}`,
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
