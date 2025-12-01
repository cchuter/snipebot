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
- On a `CreateSale` event it logs the token, checks the blacklist, then calls `scripts/buy_launchpad_token.js` to submit a launchpad buy immediately.
- All activity is appended to `logs/snipebot.log` (including buy script stdout/stderr).
- Successful buys are appended to `tokens_bought.csv` (token name, symbol, vault, tx id, amount).
  - Set `SNIPEBOT_DEBUG=true` to see verbose stdout/stderr from the buy script.

## Env vars

- `WALLET_PRIVATE_KEY`, `WALLET_ADDRESS` — required signer used for buys.
- `BUY_AMOUNT` — how much of the base token to spend per launch.
- `SLIPPAGE` — slippage factor passed to the launchpad buy script (e.g., `0.05`).
- `GALA_BUNDLE_WS` — bundle websocket URL.
- `SNIPEBOT_DEBUG` — set to true/1 for verbose buy-script logging.
- `SKIP_QUOTE` — set to true/1 to bypass quoting and submit buys immediately (higher risk; expects pool ready).
- `tokens_bought.csv` is used by `npm run check:launchpad` to query holdings.

## Utility scripts

- `npm run check:launchpad` — queries launchpad balances for tokens listed in `tokens_bought.csv` using your `WALLET_PRIVATE_KEY`.
- `npm run buy:launchpad -- <TOKEN_NAME> [amount=66] [slippage=0.05]` — manually submit a launchpad buy via the SDK (same script the bot uses).

## Disclaimer

This software is provided “AS IS”, without warranties or guarantees of any kind. Use at your own risk. Trading involves risk; the authors and contributors are not responsible for any loss of funds or other damages.

## Blacklist behavior

If the creator/additional key from the sale or the launchpad vault’s address segment matches an entry in `blacklist.csv`, the bot logs the skip and will not buy that token. Keep one address per line under the `address` header.

## Notes

- The bot assumes pools list the launch token as `Token|Unit|<symbol>|<key>` with a base of `GALA|Unit|none|none` (matches pump.gala.com launches). Adjust `BASE_TOKEN` if the sale uses a different base asset.
- The websocket walker is recursive and event-driven so launches are processed even if nested deep in payloads.
