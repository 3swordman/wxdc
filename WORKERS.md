# WXDC on Cloudflare Workers

The Vite frontend and TypeScript Worker provide the single-user ordering application. D1 stores preferences, menus, pending orders, and activity. A Durable Object serializes canteen operations and stores the canteen OAuth session.

## Prerequisites

- Node.js 22.13 or later and pnpm 10.34.8; a Cloudflare account with Workers, D1, and Durable Objects.
- A separate app password of at least 12 characters, and a random session secret of at least 32 characters.
- Your canteen student number, the OpenID of the WeChat account already bound to it in the official portal, a valid canteen JSESSIONID, and a DeepSeek API key.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` locally with your values. Keep the file out of Git. Choose a separate password for WXDC.

```bash
pnpm run db:local
pnpm run dev
```

Open the address printed by Vite, sign in with `APP_PASSWORD`, and configure your meal schedule and preferences. The local database is separate from the deployed D1 database. Both scheduled generation and automatic submission start disabled. Manual generation contacts the live canteen and DeepSeek APIs; submitting or editing orders changes real orders.

## Deployment

1. Run `pnpm exec wrangler login`, then `pnpm exec wrangler d1 create wxdc`. Put the returned database ID in `wrangler.jsonc`.
2. Apply the database schema with `pnpm run db:remote`.
3. Ensure `.dev.vars` contains your real values, then build and upload the Worker and those secrets together:

   ```bash
   pnpm run build
   pnpm exec wrangler deploy --secrets-file .dev.vars
   ```

   This command deploys the application. `.dev.vars` remains a local file and must not be committed or shared. `WECHAT_CENTER_ID` may be omitted to use `9053`.

4. Open the displayed Worker URL. Use HTTPS for login. Settings and data start empty; no existing Python data is imported. To update an individual deployed secret later, use `pnpm exec wrangler secret put SECRET_NAME`; this immediately creates and deploys a new Worker version.
5. Verify the balance and menu after binding your canteen account in the official WeChat portal. Enable scheduled generation and automatic submission when ready.

When scheduled generation is enabled, the Worker checks both upcoming order weeks daily at 08:00 and 18:00 Asia/Shanghai (00:00 and 10:00 UTC). Each configured date is checked separately. A date is ready when one of its configured meals offers a dish in a category other than 套餐. DeepSeek receives one request per ready date and can choose from the available dishes for that date's configured meals.

D1 records dates with active orders. The Worker skips cached dates and checks the canteen for active orders on the remaining dates before using DeepSeek. Any active order marks the whole date as ordered, including a partial order. Dates without available dishes are checked again on a later run.

With **自动提交** enabled, scheduled runs submit the choices to the canteen. Otherwise, scheduled runs add new dates to the pending drafts for review. **AI 立即订餐** on the home page runs the same date checks and submits after you confirm, regardless of the automation settings. The weekly generation buttons create drafts for manual review.

Menus group dishes by the canteen's food categories. Category names are cached for 24 hours; if the category service is unavailable, dishes remain visible under “其他” and the app waits 15 minutes before trying again. Opening an older pending order without category names may require one canteen session to load them.

DeepSeek receives each offered dish's category and the active reservations from the seven calendar days before each target date. Reservation context contains the date, meal, and dish name. Daily generation also includes choices submitted or saved as drafts earlier in the same run, labeled separately from active reservations.

## Test both logins

1. Open the official canteen portal inside WeChat and bind your account there if prompted. Keep the portal open.
2. In a separate browser, open the updated WXDC and sign in. Wait for **当前余额** to load. Use the OpenID from the same binding and a valid JSESSIONID in WXDC.
3. Switch back to the still-open WeChat portal. Open an order detail or run a fresh order search. Refresh **当前余额** in WXDC by reloading its home page. Successful requests in both sessions show they can coexist for that test.
4. Close and reopen the canteen portal through its normal WeChat entry point, then refresh WXDC's balance again. Query orders in the open portal once more. An expired login or a Worker log saying `Canteen rejected the cached OAuth token` immediately after signing in on the other side can indicate that the canteen invalidates older tokens. Keep the binding in place throughout the test.

WXDC reuses its OAuth token until the canteen rejects it. The first expired read in an operation can refresh the token and retry. An expired order or cancellation is reported for review before another attempt. If OAuth itself fails, check the binding in the official portal and update `WECHAT_JSESSIONID` if needed. `CANTEEN_PASSWORD` can be removed from the Worker configuration.

## Important operating details

- The upstream canteen service uses HTTP. Its connection from Cloudflare is not encrypted, even when users connect to your Worker with HTTPS. Cloudflare-to-canteen connectivity has not been verified.
- DeepSeek API calls may incur charges. When the Worker returns invalid or unconfirmed results, the pending order is retained for inspection rather than automatically retried.
- If the scheduled run approaches Cloudflare's time limit, the next run checks the remaining dates.
- Login failures are rate-limited. The single application password is distinct from the canteen password.
- The legacy Python application has been removed. Its documentation, configuration, and local data are preserved in `backup/`, which is ignored by Git and is not automatically uploaded or imported. Live parity cannot be verified while the canteen account is locked.

## Checks

```bash
pnpm run check
pnpm test
pnpm run build
```

Tests mock upstream APIs and do not bind the canteen account or place orders. Local cron triggers can be tested using the Wrangler/Vite Local Explorer, but only enable them after supplying safe settings and understanding that they can submit real orders.

Lefthook installs Git hooks during `pnpm install`: pre-commit checks formatting and lint, commit messages must use a scoped conventional format such as `feat(worker): add feature`, and pre-push checks types. Run `pnpm run format` or `pnpm run lint:fix` to fix supported issues.
