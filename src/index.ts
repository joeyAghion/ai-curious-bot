interface Env {
  KV: KVNamespace;
  ANTHROPIC_ADMIN_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
}

interface SpendSummary {
  amount: string | null;
  period_to_date_spend: string;
}

interface SpendLimitIncreaseRequest {
  id: string;
  status: "pending" | "approved" | "denied";
  actor: {
    type: string;
    user_id: string;
    name: string;
    email_address: string;
    deleted: boolean;
  };
  spend_summary: SpendSummary | null;
}

interface AnthropicListResponse<T> {
  data: T[];
  next_page: string | null;
}

interface ThreadRecord {
  channel: string;
  threadTs: string;
  requesterSlackId: string | null;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
}

const ANTHROPIC_VERSION = "2023-06-01";
const THREAD_KEY_PREFIX = "thread:";
const SLACK_ID_CACHE_PREFIX = "slackid:";
const SLACK_ID_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;
const AUTO_APPROVAL_MULTIPLIER = 1.2;
const MIN_EXPLANATION_LENGTH = 5;

async function fetchPendingRequests(env: Env): Promise<SpendLimitIncreaseRequest[]> {
  const results: SpendLimitIncreaseRequest[] = [];
  let page: string | null = null;

  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/spend_limit_increase_requests");
    url.searchParams.set("status[]", "pending");
    url.searchParams.set("limit", "100");
    if (page) url.searchParams.set("page", page);

    const res = await fetch(url, {
      headers: {
        "x-api-key": env.ANTHROPIC_ADMIN_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    }

    const body = (await res.json()) as AnthropicListResponse<SpendLimitIncreaseRequest>;
    console.log(body);
    results.push(...body.data);
    page = body.next_page;
  } while (page);

  return results;
}

async function approveRequest(env: Env, requestId: string, amountCents: number): Promise<void> {
  const res = await fetch(
    `https://api.anthropic.com/v1/organizations/spend_limit_increase_requests/${requestId}/approve`,
    {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_ADMIN_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: String(amountCents), suppress_notification: true }),
    }
  );

  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
  }
}

async function lookupSlackUserId(env: Env, email: string): Promise<string | null> {
  const cacheKey = `${SLACK_ID_CACHE_PREFIX}${email.toLowerCase()}`;
  const cached = await env.KV.get(cacheKey);
  if (cached !== null) {
    return cached === "none" ? null : cached;
  }

  const url = new URL("https://slack.com/api/users.lookupByEmail");
  url.searchParams.set("email", email);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const body = (await res.json()) as { ok: boolean; user?: { id: string } };

  const slackId = body.ok && body.user ? body.user.id : null;
  await env.KV.put(cacheKey, slackId ?? "none", { expirationTtl: SLACK_ID_CACHE_TTL_SECONDS });
  return slackId;
}

async function postSlackMessage(env: Env, text: string, threadTs?: string): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: env.SLACK_CHANNEL_ID,
      text,
      unfurl_links: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
  });

  const body = (await res.json()) as { ok: boolean; error?: string; ts?: string };
  if (!body.ok || !body.ts) {
    throw new Error(`Slack API error: ${body.error}`);
  }
  return body.ts;
}

async function fetchThreadReplies(env: Env, channel: string, threadTs: string): Promise<SlackMessage[]> {
  const url = new URL("https://slack.com/api/conversations.replies");
  url.searchParams.set("channel", channel);
  url.searchParams.set("ts", threadTs);
  url.searchParams.set("limit", "200");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  const body = (await res.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
  if (!body.ok) {
    throw new Error(`Slack API error: ${body.error}`);
  }

  // conversations.replies includes the thread's parent message first; drop it.
  return (body.messages ?? []).slice(1);
}

function messageFor(request: SpendLimitIncreaseRequest, mention: string | null): string {
  const who = mention ?? `*${request.actor.name}*`;
  return `🚀 ${who} recently requested more Claude usage — sounds like you're deep into something! Mind sharing a quick note or link here about what you're building? Reply in this thread and I'll bump your limit. Others might pick up a new technique from it too. 🧵`;
}

function findExplanationReply(replies: SlackMessage[], requesterSlackId: string): SlackMessage | null {
  return (
    replies.find(
      (m) => m.user === requesterSlackId && (m.text ?? "").trim().length > MIN_EXPLANATION_LENGTH
    ) ?? null
  );
}

async function notifyNewRequest(env: Env, request: SpendLimitIncreaseRequest): Promise<ThreadRecord> {
  const slackId = request.actor.email_address
    ? await lookupSlackUserId(env, request.actor.email_address)
    : null;
  const mention = slackId ? `<@${slackId}>` : null;

  const ts = await postSlackMessage(env, messageFor(request, mention));
  return { channel: env.SLACK_CHANNEL_ID, threadTs: ts, requesterSlackId: slackId };
}

async function maybeAutoApprove(
  env: Env,
  request: SpendLimitIncreaseRequest,
  thread: ThreadRecord
): Promise<void> {
  // Without a resolved Slack identity we can't tell the requester's own reply apart from anyone else's.
  if (!thread.requesterSlackId) {
    console.log(`Skipping auto-approval for ${request.id}: requester has no resolved Slack ID`);
    return;
  }

  const currentAmount = request.spend_summary?.amount;
  if (currentAmount == null) return;

  const replies = await fetchThreadReplies(env, thread.channel, thread.threadTs);
  const explanation = findExplanationReply(replies, thread.requesterSlackId);
  if (!explanation) return;

  const newAmount = Math.round(parseFloat(currentAmount) * AUTO_APPROVAL_MULTIPLIER);
  await approveRequest(env, request.id, newAmount);
  await postSlackMessage(
    env,
    `✅ Thanks for the context! I've raised your limit by 20%.`,
    thread.threadTs
  );
}

async function handleRequest(env: Env, request: SpendLimitIncreaseRequest): Promise<void> {
  const threadKey = `${THREAD_KEY_PREFIX}${request.id}`;
  const stored = await env.KV.get(threadKey);

  if (!stored) {
    const thread = await notifyNewRequest(env, request);
    await env.KV.put(threadKey, JSON.stringify(thread));
    return;
  }

  const thread = JSON.parse(stored) as ThreadRecord;
  await maybeAutoApprove(env, request, thread);
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const pending = await fetchPendingRequests(env);
    for (const request of pending) {
      try {
        await handleRequest(env, request);
      } catch (err) {
        console.error(`Failed to process request ${request.id}:`, err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
