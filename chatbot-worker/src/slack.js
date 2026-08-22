const SLACK_API = "https://slack.com/api";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

async function slackPost(env, method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.log("slack_error", data.error || "unknown");
    return null;
  }
  return data;
}

async function startSlackThread(env, sessionId, firstMessage) {
  const posted = await slackPost(env, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    text: `🆕 New chat — session ${sessionId}\n*Visitor:* ${firstMessage}`,
  });
  if (!posted) return;

  const threadTs = posted.ts;
  await Promise.all([
    env.CHAT_KV.put(
      `sess:${sessionId}`,
      JSON.stringify({ threadTs, createdAt: Date.now() }),
      { expirationTtl: SESSION_TTL_SECONDS }
    ),
    env.CHAT_KV.put(`thread:${threadTs}`, sessionId, { expirationTtl: SESSION_TTL_SECONDS }),
  ]);
}

async function postSlackTurn(env, threadTs, visitorMessage, botReply, mode) {
  await slackPost(env, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text: `*Visitor:* ${visitorMessage}`,
  });
  await slackPost(env, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    thread_ts: threadTs,
    text: `*Bot* (${mode}): ${botReply}`,
  });
}

// Best-effort, one-way session logging (Phase 2). Never throws — callers run
// this inside ctx.waitUntil() and a failure here must never affect the
// visitor's reply.
export async function logChatToSlack(env, { sessionId, sessionMeta, visitorMessage, botReply, mode }) {
  try {
    if (!sessionMeta?.threadTs) {
      await startSlackThread(env, sessionId, visitorMessage);
      return;
    }
    await postSlackTurn(env, sessionMeta.threadTs, visitorMessage, botReply, mode);
  } catch (err) {
    console.log("slack_log_error", err?.name || "unknown");
  }
}
