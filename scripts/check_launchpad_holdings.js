#!/usr/bin/env node
/**
 * Query balances for launchpad tokens listed in tokens_bought.csv.
 *
 * Usage:
 *   node scripts/check_launchpad_holdings.js [optional-symbol-filter]
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { LaunchpadSDK } = require('@gala-chain/launchpad-sdk');
const { Wallet } = require('ethers');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('WALLET_PRIVATE_KEY is required to query launchpad balances.');
  process.exit(1);
}

const filter = process.argv[2]?.toUpperCase() ?? null;
const TOKENS_CSV = path.resolve(__dirname, '..', 'tokens_bought.csv');

function vaultToTokenId(vault) {
  if (!vault || typeof vault !== 'string') return null;
  const clean = vault.replace(/^service\|/, '');
  const parts = clean.split('$');
  if (parts.length < 4) return null;
  const [collection, category, type, ...rest] = parts;
  const additional = rest.join('$');
  return `${collection}|${category}|${type}|${additional}`;
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_CSV)) {
    console.error('tokens_bought.csv not found; nothing to query.');
    process.exit(1);
  }
  const entries = [];
  const rows = fs.readFileSync(TOKENS_CSV, 'utf8').split(/\r?\n/).filter(Boolean);
  rows.slice(1).forEach((line) => {
    const [tokenName, symbol, vaultAddress] = line.split(',').map((s) => s?.trim());
    if (tokenName || symbol || vaultAddress) {
      entries.push({ tokenName, symbol, vaultAddress });
    }
  });
  return entries;
}

function buildSdk(wallet) {
  const envRaw = process.env.LAUNCHPAD_ENV || 'PROD';
  const env = envRaw.toUpperCase();
  const config = { wallet, env };
  if (process.env.LAUNCHPAD_BASE_URL) config.baseUrl = process.env.LAUNCHPAD_BASE_URL;
  if (process.env.BUNDLE_BASE_URL) config.bundleBaseUrl = process.env.BUNDLE_BASE_URL;
  if (process.env.GALACHAIN_GATEWAY) config.galaChainBaseUrl = process.env.GALACHAIN_GATEWAY;

  if (env === 'PROD') {
    if (!config.baseUrl) config.baseUrl = 'https://lpad-backend-prod1.defi.gala.com';
    if (!config.bundleBaseUrl) config.bundleBaseUrl = 'https://bundle-backend-prod1.defi.gala.com';
    if (!config.galaChainBaseUrl) {
      config.galaChainBaseUrl =
        'https://galachain-gateway-chain-platform-prod-chain-platform-eks.prod.galachain.com';
    }
  }

  return new LaunchpadSDK(config);
}

async function fetchHolding(sdk, address, entry) {
  const vault = entry.vaultAddress;
  const tokenId = vaultToTokenId(vault);
  const queries = [];
  if (tokenId) queries.push({ tokenId });
  if (entry.tokenName) queries.push({ tokenName: entry.tokenName });
  if (entry.symbol) queries.push({ tokenName: entry.symbol });

  for (const opt of queries) {
    try {
      const res = await sdk.fetchTokenBalance({ address, ...opt });
      if (res && res.quantity && parseFloat(res.quantity) > 0) {
        return {
          name: res.name || entry.tokenName || entry.symbol || 'unknown',
          symbol: res.symbol || entry.symbol || 'unknown',
          quantity: res.quantity,
          tokenId: res.tokenId || tokenId || vault || 'unknown',
        };
      }
    } catch (err) {
      // try next approach
    }
  }
  return null;
}

async function main() {
  const wallet = new Wallet(PRIVATE_KEY);
  const galaAddress = `eth|${wallet.address.replace(/^0x/i, '')}`;
  const sdk = buildSdk(wallet);
  const entries = loadTokens();

  const holdings = [];
  for (const entry of entries) {
    const matchFilter =
      !filter ||
      (entry.symbol && entry.symbol.toUpperCase().includes(filter)) ||
      (entry.tokenName && entry.tokenName.toUpperCase().includes(filter));
    if (!matchFilter) continue;

    // eslint-disable-next-line no-await-in-loop
    const holding = await fetchHolding(sdk, galaAddress, entry);
    if (holding) holdings.push(holding);
  }

  console.log(`Launchpad holdings for ${galaAddress}`);
  if (!holdings.length) {
    console.log(' - none found (check tokens_bought.csv or filter)');
    return;
  }

  holdings.sort((a, b) => a.name.localeCompare(b.name));
  holdings.forEach((h) => {
    console.log(` - ${h.name} (${h.symbol}) [${h.tokenId}]: ${h.quantity}`);
  });
}

main().catch((err) => {
  console.error('Failed to fetch launchpad holdings:', err?.message || err);
  process.exit(1);
});
