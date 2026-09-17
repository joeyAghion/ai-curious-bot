interface Env {
  KV: KVNamespace;
  ANTHROPIC_ADMIN_KEY: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
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
}

interface AnthropicListResponse<T> {
  data: T[];
  next_page: string | null;
}

const ANTHROPIC_VERSION = "2023-06-01";
const NOTIFIED_KEY_PREFIX = "notified:";
const SLACK_ID_CACHE_PREFIX = "slackid:";
const SLACK_ID_CACHE_TTL_SECONDS = 60 * 60 * 24 * 7;

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

async function postSlackMessage(env: Env, text: string): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: env.SLACK_CHANNEL_ID, text, unfurl_links: false }),
  });

  const body = (await res.json()) as { ok: boolean; error?: string };
  if (!body.ok) {
    throw new Error(`Slack API error: ${body.error}`);
  }
}

function messageFor(request: SpendLimitIncreaseRequest, mention: string | null): string {
  const who = mention ?? `*${request.actor.name}*`;
  return `🚀 ${who} recently requested more Claude usage — sounds like you're deep into something! Mind sharing a quick note here about what you're building? Others might pick up a new technique from it. 🧵`;
}

async function handleRequest(env: Env, request: SpendLimitIncreaseRequest): Promise<void> {
  const notifiedKey = `${NOTIFIED_KEY_PREFIX}${request.id}`;
  if (await env.KV.get(notifiedKey)) return;

  const slackId = request.actor.email_address
    ? await lookupSlackUserId(env, request.actor.email_address)
    : null;
  const mention = slackId ? `<@${slackId}>` : null;

  await postSlackMessage(env, messageFor(request, mention));
  await env.KV.put(notifiedKey, "1");
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const pending = await fetchPendingRequests(env);
    for (const request of pending) {
      try {
        await handleRequest(env, request);
      } catch (err) {
        console.error(`Failed to notify for request ${request.id}:`, err);
      }
    }
  },
} satisfies ExportedHandler<Env>;
