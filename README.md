# Stomp Tally

Daily step stakes for a friend group. Everyone logs their [Stompers](https://stompers.com) step count. Each day, whoever has the fewest steps **and** is under 10,000 owes $5 toward the monthly group meal. The app keeps the running tally.

Invite-only. Email magic-link login, no passwords. Runs on Cloudflare Workers + D1 (free tier is plenty for a handful of people).

## Rules

- Lowest steps under the goal (default 10,000) owes the penalty (default $5). Exactly 10,000 is safe.
- Ties at the lowest: everyone tied pays.
- No entry for the day counts as 0 steps.
- Each person logs their own steps for today, or yesterday until it locks. Days lock at **12:00 noon the next day** (group timezone), then only an admin can correct them.
- **Skips:** 3 per person per calendar month, claimed manually before the day locks. A skip is only used up if it actually saves you from paying. Otherwise it's released. A used skip never moves the penalty to someone else.
- An admin can correct any past day. Correcting a locked day recomputes it.

## Stack

React Router v8 (SSR) · Cloudflare Workers · D1 (SQLite) · Cron Trigger (hourly finalize) · Tailwind v4 · Resend (email) · Vitest

## Layout

```
app/lib/rules.ts        pure money logic (who pays), unit-tested
app/lib/service.ts      write-side business logic, takes a tiny Db interface
app/lib/pages.ts        one SQL statement per page, including session and group lookup
app/lib/views.ts        pure view builders, no database calls
app/lib/db.ts           Db interface + D1 adapter with request-scoped timing
app/lib/dates.ts        timezone / lock-time helpers
app/lib/mail.server.ts  Resend sender (logs to console when no API key)
app/routes/             pages: today, month, history (ledger), me, group (admin), login, invite, setup
workers/app.ts          Worker entry: security headers + hourly `scheduled()` finalize
migrations/             D1 schema
scripts/smoke.sh        end-to-end HTTP smoke test against `npm run dev`
```

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars          # local-only secrets, git-ignored
npx wrangler d1 migrations apply stomp-tally --local
npm run dev                              # http://localhost:5173
```

With no `RESEND_API_KEY`, emails are printed to the dev server console instead of sent, so you can copy login and invite links from there. Open `/setup` first (it asks for `SETUP_KEY` from `.dev.vars`) to create the admin.

## Test

```bash
npm test             # rules + service tests (real SQLite via node:sqlite, using the real migration)
npm run typecheck
npm run build
```

End-to-end smoke test on a throwaway local database (needs Node 22+):

```bash
P=$(mktemp -d); npx wrangler d1 migrations apply stomp-tally --local --persist-to $P
STOMP_PERSIST=$P npm run dev -- --port 5173 --strictPort > /tmp/stomp-dev.log 2>&1 &
LOG=/tmp/stomp-dev.log bash scripts/smoke.sh
```

## Deploy

One-time setup (auth with `wrangler login`, or a scoped `CLOUDFLARE_API_TOKEN`):

```bash
npx wrangler d1 create stomp-tally          # copy the database_id into wrangler.jsonc
npx wrangler d1 migrations apply stomp-tally --remote
npx wrangler secret put SETUP_KEY           # you'll type this on /setup to create the first admin
npx wrangler secret put RESEND_API_KEY
npm run deploy
```

Then open `https://<your-domain>/setup`, create the admin, and invite people from the ⚙️ Group page.

- The domain in `wrangler.jsonc` (`routes` and `APP_URL`) must be on your Cloudflare account. `MAIL_FROM` must be on a domain verified in Resend (SPF/DKIM).
- `/setup` is disabled until `SETUP_KEY` is set, and locks permanently once any user exists.
- Schema changes: add a new `migrations/000N_*.sql`, apply with `--remote`. Never edit an applied migration.

## Security notes

- Login and invite tokens are random, stored only as SHA-256 hashes, and single-use. The login-link page needs a button press, so email link scanners can't burn the token.
- An invite is bound to one email. Accepting it sends a confirm link to that address, and membership is only granted if the logged-in email matches.
- Login, setup and invite endpoints are rate-limited (Workers rate-limit binding).
- No secrets live in the repo. `.dev.vars` is git-ignored; production secrets are Wrangler secrets.

## Performance

Each main page uses **one SQL statement and one D1 round trip**, including authentication. A CTE resolves the session and group, and separate JSON-aggregated subqueries fetch the datasets without multiplying rows. The shared layout uses the child page's result instead of doing another lookup.

`pages.test.ts` enforces the one-call limit and tests expired sessions, cross-group isolation and timezone/month boundaries. Responses include `X-DB-Calls`, `X-DB-Statements` and `Server-Timing` so latency can be verified on the deployed Worker. Smart Placement is enabled; it may take time to learn a better location.

This budget applies to page reads, not mutations (writes may need validation and a transaction).

## Loading feedback

Navigation and form submissions immediately show a loading overlay. Continue shows “Logging you in…” through the login POST and redirect; form buttons show a spinner and disable repeat submissions. The page behind the overlay is inert for pointer and keyboard input. Automatic background refresh stays silent.

Browser regression checks hold real requests open (without mocking responses) and verify success, error recovery, duplicate taps, redirects and background refresh:

```bash
LOG=/path/to/dev-server.log node scripts/pending-browser.mjs
```

Run after `scripts/smoke.sh` against its local fixture. Uses Chromium at `/usr/bin/chromium`, or set `CHROMIUM`. The tests never use a production account.

## Not built yet

- Pulling steps straight from the Stompers API instead of manual entry (leaderboard numbers include power-ups, so Apple Health can't be the source). Parked until the endpoints are tested.
- Screenshot upload as a dispute fallback.
