# snipebot

Autobuy bot for pump.gala.com tokens. It watches the Gala bundle websocket for `CreateSale` events, waits for the matching pool to exist, and immediately swaps into the new token using `@gala-chain/gswap-sdk`. All launches, skips, retries, and buys are logged.

## Setup

1. Clone this repo and install dependencies:
   ```bash
   npm install
   ```
2. Create `.env` from the template and fill in wallet + sizing:
   ```bash
   cp .env.example .env
   # edit .env with your WALLET_PRIVATE_KEY, WALLET_ADDRESS, and BUY_AMOUNT
   ```
3. Add any creator addresses you want to skip to `blacklist.csv` (one per line under the `address` header). Supported forms: `eth|0xabc...` or `client|123...`.

## Running

```bash
npm start
```

What happens:
- Connects to `wss://bundle-backend-prod1.defi.gala.com` (override with `GALA_BUNDLE_WS`).
- On a `CreateSale` event it logs the token, checks the blacklist, then waits for the pool to come online.
- Uses exponential backoff (configurable via `RETRY_BASE_MS`/`RETRY_MAX_MS`) to avoid spew while probing for the pool.
- As soon as quoting works, it swaps `BASE_TOKEN` (default `GALA|Unit|none|none`) into the new token for `BUY_AMOUNT`, honoring `SLIPPAGE`.
- All activity is appended to `logs/snipebot.log`.

## Env vars

- `WALLET_PRIVATE_KEY`, `WALLET_ADDRESS` — required signer used for buys.
- `BUY_AMOUNT` — how much of the base token to spend per launch.
- `BASE_TOKEN` — token to swap from (defaults to GALA native).
- `SLIPPAGE` — multiplier applied to quoted out amount (e.g., `0.98` keeps 2% buffer).
- `GALA_BUNDLE_WS` — bundle websocket URL.
- `RETRY_BASE_MS`, `RETRY_MAX_MS` — backoff tuning while waiting for pools to exist.

## Blacklist behavior

If the creator/additional key from the sale or the launchpad vault’s address segment matches an entry in `blacklist.csv`, the bot logs the skip and will not buy that token. Keep one address per line under the `address` header.

## Notes

- The bot assumes pools list the launch token as `Token|Unit|<symbol>|<key>` with a base of `GALA|Unit|none|none` (matches pump.gala.com launches). Adjust `BASE_TOKEN` if the sale uses a different base asset.
- The websocket walker is recursive and event-driven so launches are processed even if nested deep in payloads.
