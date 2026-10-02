# AI Curious Bot

Polls the Claude Enterprise Spend Limits API for pending "request more usage"
requests (the ones that show up in your org dashboard and generate owner
emails when a member clicks **Request more usage** in claude.ai), posts a
Slack message tagging the requester prompting them to share what they're
building, and auto-approves a 20% limit increase once the requester replies
in the thread with more than a few characters.

Runs as a Cloudflare Worker on a Cron Trigger — no public-facing endpoint or
Slack Events subscription required; everything (including thread replies) is
read by polling. State (which requests have an open thread, a cache of
email → Slack user ID lookups) is kept in a KV namespace.

**Auto-approval is an honor-system gate, not a review**: any reply over 5
characters from the requester counts, with no check on whether it actually
explains anything. If you want a human in the loop instead, remove the
`maybeAutoApprove` call in `handleRequest` (in `src/index.ts`) and keep only
the notification.

## Prerequisites

- `npx wrangler login` — Cloudflare account access (already done if you set
  this project up).
- An **Anthropic Admin API key for your Claude Enterprise org**, with both
  the `read:spend_limits` **and** `write:spend_limits` scopes. Create it in
  claude.ai → Organization settings. Scopes are fixed at creation — if your
  existing key only has `read:spend_limits`, you need a new key, not an
  edited one. A Console/`platform.claude.com` Admin API key from a different
  org will not see these requests.
- A **Slack app** with the `chat:write`, `users:read.email`, and
  `channels:history` (or `groups:history` if the target channel is private)
  bot scopes, installed to your workspace, invited to the target channel
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
  deployed namespace. Thread records persist across local runs; delete
  `.wrangler/state` to reset and re-trigger notifications for the same
  request.
- **There must be an actual pending request** for `fetchPendingRequests` to
  return anything. If nobody's currently over their spend limit, the run
  will simply find nothing to do. To manufacture a test case, temporarily
  set a low per-user spend limit (`POST /v1/organizations/spend_limits`)
  and click "Request more usage" yourself in claude.ai.
- **To test the auto-approval path**, run `__scheduled` once to post the
  initial message, reply in that thread yourself (as the same Slack user
  the requester's email resolved to) with something longer than 5
  characters, then run `__scheduled` again — that second run is the one
  that reads the thread and calls `/approve`.

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
   `GET /v1/organizations/spend_limit_increase_requests` (paginated). Each
   row includes a live `spend_summary.amount` — the requester's current
   effective spend limit, in cents.
2. For a request with no thread recorded yet in KV (`thread:<request id>`):
   - Resolve `actor.email_address` to a Slack user ID via
     `users.lookupByEmail` (cached in KV for 7 days).
   - Post a message to `SLACK_CHANNEL_ID`, `@`-mentioning the user if
     resolved, otherwise falling back to their name.
   - Record `{ channel, threadTs, requesterSlackId }` in KV so later runs
     can find this thread again (no expiry — request IDs never repeat).
3. For a request that already has a thread recorded:
   - Read the thread's replies via `conversations.replies`.
   - If the requester (matched by Slack user ID, not just anyone in the
     thread) has replied with more than 5 characters, approve the request
     at 20% over its current limit via
     `POST .../spend_limit_increase_requests/{id}/approve`, and post a
     confirmation reply in the thread.
   - Once approved (or denied by you elsewhere), the request drops out of
     the `pending` list, so later runs simply stop considering it — no
     cleanup needed.

If a requester's email doesn't resolve to a Slack account, step 3 is
skipped for that request (logged, not auto-approved) since there's no way
to attribute thread replies to them.
