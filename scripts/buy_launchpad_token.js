#!/usr/bin/env node
/**
 * Buy a launchpad token on Gala launchpad (production) using the Launchpad SDK.
 *
 * Usage:
 *   WALLET_PRIVATE_KEY=... node scripts/buy_launchpad_token.js <TOKEN_NAME> [amountGala=66] [slippage=0.05]
 *
 * Example:
 *   WALLET_PRIVATE_KEY=0xabc... node scripts/buy_launchpad_token.js MGGALG 66 0.05
 *
 * Optional environment overrides:
 *   LAUNCHPAD_BASE_URL   (default: https://lpad-backend-prod1.defi.gala.com)
 *   LAUNCHPAD_ENV        (default: production)
 */

const path = require('path');
const dotenv = require('dotenv');
const { Wallet } = require('ethers');
const { LaunchpadSDK } = require('@gala-chain/launchpad-sdk');
const BigNumber = require('bignumber.js');

// Load .env from repo root
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const [, , tokenArg, amountArg, slippageArg] = process.argv;
const vaultFromEnv = process.env.LAUNCHPAD_VAULT_ADDRESS;

if (!tokenArg) {
  console.error('Usage: WALLET_PRIVATE_KEY=... node scripts/buy_launchpad_token.js <TOKEN_NAME> [amountGala=66] [slippage=0.05]');
  process.exit(1);
}

const PRIVATE_KEY = process.env.WALLET_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('Missing WALLET_PRIVATE_KEY in env');
  process.exit(1);
}

const TOKEN_SYMBOL = tokenArg.trim();
const TOKEN_NAME_OVERRIDE = process.env.LAUNCHPAD_TOKEN_NAME?.trim();
const TOKEN_ID_OVERRIDE = process.env.LAUNCHPAD_VAULT_ADDRESS?.trim();
const AMOUNT_GALA = amountArg || '66';
const SLIPPAGE = Number.isFinite(parseFloat(slippageArg)) ? parseFloat(slippageArg) : 0.05;
const SEARCH_LIMIT = Number.parseInt(process.env.LAUNCHPAD_SEARCH_LIMIT || '100', 10); // backend max 100
const DEBUG = (process.env.LAUNCHPAD_DEBUG || '').toLowerCase() === '1';

function logDebug(...args) {
  if (DEBUG) {
    console.log('[debug]', ...args);
  }
}

async function main() {
  const wallet = new Wallet(PRIVATE_KEY);
  const envRaw = process.env.LAUNCHPAD_ENV || 'PROD';
  const env = envRaw.toUpperCase(); // SDK expects 'PROD'/'STAGE', not 'production'

  const config = {
    wallet,
    env,
  };

  if (process.env.LAUNCHPAD_BASE_URL) config.baseUrl = process.env.LAUNCHPAD_BASE_URL;
  if (process.env.BUNDLE_BASE_URL) config.bundleBaseUrl = process.env.BUNDLE_BASE_URL;
  if (process.env.GALACHAIN_GATEWAY) config.galaChainBaseUrl = process.env.GALACHAIN_GATEWAY;

  // Explicit prod defaults to avoid undefined launchpadBaseUrl
  if (!config.baseUrl && env === 'PROD') {
    config.baseUrl = 'https://lpad-backend-prod1.defi.gala.com';
  }
  if (!config.bundleBaseUrl && env === 'PROD') {
    config.bundleBaseUrl = 'https://bundle-backend-prod1.defi.gala.com';
  }
  if (!config.galaChainBaseUrl && env === 'PROD') {
    config.galaChainBaseUrl = 'https://galachain-gateway-chain-platform-prod-chain-platform-eks.prod.galachain.com';
  }

  const sdk = new LaunchpadSDK(config);

  async function searchPool(term) {
    const matches = [];
    for (const type of ['recent', 'popular']) {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages && page <= 50) {
        try {
          const pools = await sdk.fetchPools({ type, limit: SEARCH_LIMIT, page, search: term });
          totalPages = pools?.totalPages || totalPages;
          logDebug(`fetched pools type=${type} page=${page}/${totalPages} count=${pools?.pools?.length || 0}`);
          if (pools?.pools?.length) {
            const sample = pools.pools.slice(0, 3).map((p) => ({
              tokenName: p.tokenName,
              symbol: p.symbol,
              vaultAddress: p.vaultAddress,
            }));
            logDebug('sample pools:', sample);
            matches.push(
              ...pools.pools.filter(
                (p) =>
                  p.tokenName?.toUpperCase() === term.toUpperCase() || p.symbol?.toUpperCase() === term.toUpperCase(),
              ),
            );
          }
        } catch (err) {
          // stop paging on validation errors like 404/limits
          logDebug(`fetchPools error on type=${type} page=${page}:`, err?.message || err);
          break;
        }
        page += 1;
      }
      if (matches.length) {
        break;
      }
    }
    return matches;
  }

  async function resolveTokenName(tokenOrSymbol) {
    const terms = [tokenOrSymbol, tokenOrSymbol.toUpperCase(), tokenOrSymbol.toLowerCase()];
    const seen = new Set();
    for (const term of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const matches = await searchPool(term);
      if (matches.length) {
        const m = matches[0];
        logDebug('matched pool:', { tokenName: m.tokenName, symbol: m.symbol, vaultAddress: m.vaultAddress });
        return { tokenName: m.tokenName, tokenId: m.vaultAddress };
      }
    }
    return { tokenName: tokenOrSymbol, tokenId: null };
  }

  const nameCandidate = TOKEN_NAME_OVERRIDE || TOKEN_SYMBOL;
  const resolved = await resolveTokenName(nameCandidate);
  const tokenNameForRequest = TOKEN_NAME_OVERRIDE || resolved.tokenName || TOKEN_SYMBOL;
  const tokenId = TOKEN_ID_OVERRIDE || resolved.tokenId;

  console.log(
    `🔍 Quoting ${AMOUNT_GALA} GALA -> ${tokenNameForRequest}${tokenId ? ` (${tokenId})` : ''}`
  );
  // Passing tokenId/vault has stricter validation; rely on token name resolution instead.
  const quote = await sdk.calculateBuyAmount({
    tokenName: tokenNameForRequest,
    amount: AMOUNT_GALA,
    type: 'native',
    mode: 'external',
  });

  logDebug('quote raw:', quote);

  const expectedOut = new BigNumber(quote.amount || '0');
  const minOut = expectedOut.multipliedBy(new BigNumber(1).minus(SLIPPAGE)).toFixed();

  console.log(`Expected tokens: ${quote.amount}`);
  console.log(`Min tokens w/ slippage ${SLIPPAGE}: ${minOut}`);
  console.log(`Reverse bonding curve fee: ${quote.reverseBondingCurveFee}`);

  console.log('🚀 Submitting buy...');
  const result = await sdk.buy({
    tokenName: tokenNameForRequest,
    amount: AMOUNT_GALA,
    type: 'native',
    expectedAmount: minOut,
    slippageToleranceFactor: SLIPPAGE,
    maxAcceptableReverseBondingCurveFee: quote.reverseBondingCurveFee,
  });

  console.log('✅ Buy submitted:', result);
}

main()
  .then(() => {
    // Ensure SDK connections are cleaned up so the process can exit.
    if (typeof LaunchpadSDK.cleanupAll === 'function') {
      LaunchpadSDK.cleanupAll();
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Buy failed:', err?.message || err);
    if (typeof LaunchpadSDK.cleanupAll === 'function') {
      LaunchpadSDK.cleanupAll();
    }
    process.exit(1);
  });
