# claude-usage-request-notifier

Polls the Claude Enterprise Spend Limits API for pending "request more usage"
requests (the ones that show up in your org dashboard and generate owner
emails when a member clicks **Request more usage** in claude.ai) and posts a
Slack message tagging the requester, prompting them to share what they're
building.

Runs as a Cloudflare Worker on a Cron Trigger. State (which requests have
already been notified, and a cache of email → Slack user ID lookups) is kept
in a KV namespace.

## Prerequisites

- `npx wrangler login` — Cloudflare account access (already done if you set
  this project up).
- An **Anthropic Admin API key for your Claude Enterprise org**, with the
  `read:spend_limits` scope. Create it in claude.ai → Organization settings.
  A Console/`platform.claude.com` Admin API key from a different org will
  not see these requests.
- A **Slack app** with the `chat:write` and `users:read.email` bot scopes,
  installed to your workspace, invited to the target channel
  (`SLACK_CHANNEL_ID` in `wrangler.jsonc`, currently `C034LSACD`).

## Local setup

```bash
npm install
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in real values:

```
ANTHROPIC_ADMIN_KEY=sk-ant-admin01-...
SLACK_BOT_TOKEN=xoxb-...
```

`.dev.vars` is gitignored and only used by `wrangler dev` — it never touches
production.

While testing, consider overriding `SLACK_CHANNEL_ID` in `.dev.vars` too
(it takes precedence over the `vars` value in `wrangler.jsonc` during local
dev), pointed at a private test channel — the calls to Anthropic and Slack
are real, not mocked, so a local run will actually post to whatever channel
is configured.

## Simulate a run locally

```bash
npx wrangler dev --test-scheduled
```

In another terminal, trigger the scheduled handler on demand:

```bash
curl http://localhost:8787/__scheduled
```

Output (including `console.log`/`console.error` from the Worker) streams
into the `wrangler dev` terminal.

Notes:

- **KV is simulated locally** under `.wrangler/state`, separate from the
  deployed namespace. Notified-request IDs persist across local runs; delete
  `.wrangler/state` to reset and re-trigger notifications for the same
  request.
- **There must be an actual pending request** for `fetchPendingRequests` to
  return anything. If nobody's currently over their spend limit, the run
  will simply find nothing to do. To manufacture a test case, temporarily
  set a low per-user spend limit (`POST /v1/organizations/spend_limits`)
  and click "Request more usage" yourself in claude.ai.

## Deploy

Set the two secrets (interactive prompts — values are never passed as CLI
arguments or logged):

```bash
npx wrangler secret put ANTHROPIC_ADMIN_KEY
npx wrangler secret put SLACK_BOT_TOKEN
```

Then deploy:

```bash
npx wrangler deploy
```

The Cron Trigger schedule lives in `wrangler.jsonc` under `triggers.crons`.

## How it works

1. On each scheduled run, fetch all `pending` rows from
   `GET /v1/organizations/spend_limit_increase_requests` (paginated).
2. For each request not already recorded in KV (`notified:<request id>`):
   - Resolve `actor.email_address` to a Slack user ID via
     `users.lookupByEmail` (cached in KV for 7 days).
   - Post a message to `SLACK_CHANNEL_ID`, `@`-mentioning the user if
     resolved, otherwise falling back to their name.
   - Mark the request as notified in KV (no expiry — request IDs never
     repeat).

This only notifies — approving or denying requests is still done by you,
via claude.ai or the Spend Limits API directly.
