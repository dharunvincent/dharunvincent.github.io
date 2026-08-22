const SLACK_API = "https://slack.com/api";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

// Slack mrkdwn uses single-asterisk bold and underscore italics, not
// markdown's double-asterisk bold / single-asterisk italics.
function markdownToSlack(text) {
  if (!text) return text;
  let out = text.replace(/\*\*(.+?)\*\*/gs, "{{B}}$1{{B}}");
  out = out.replace(/\*(.+?)\*/gs, "_$1_");
  out = out.replace(/\{\{B\}\}/g, "*");
  return out;
}

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

async function postMessage(env, threadTs, text) {
  return slackPost(env, "chat.postMessage", {
    channel: env.SLACK_CHANNEL_ID,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
  });
}

async function startSlackThread(env, sessionId, firstMessage) {
  const posted = await postMessage(env, null, `🆕 New chat — session ${sessionId}\n🧑 *Visitor:* ${firstMessage}`);
  if (!posted) return null;

  const threadTs = posted.ts;
  await Promise.all([
    env.CHAT_KV.put(
      `sess:${sessionId}`,
      JSON.stringify({ threadTs, createdAt: Date.now() }),
      { expirationTtl: SESSION_TTL_SECONDS }
    ),
    env.CHAT_KV.put(`thread:${threadTs}`, sessionId, { expirationTtl: SESSION_TTL_SECONDS }),
  ]);
  return threadTs;
}

async function postSlackTurn(env, threadTs, visitorMessage, botReply, mode) {
  await postMessage(env, threadTs, `🧑 Visitor: ${visitorMessage}`);
  await postMessage(env, threadTs, `🤖 Bot (${mode}): ${markdownToSlack(botReply)}`);
}

// Best-effort, one-way session logging (Phase 2). Never throws — callers run
// this inside ctx.waitUntil() and a failure here must never affect the
// visitor's reply.
export async function logChatToSlack(env, { sessionId, sessionMeta, visitorMessage, botReply, mode }) {
  try {
    if (!sessionMeta?.threadTs) {
      const threadTs = await startSlackThread(env, sessionId, visitorMessage);
      if (!threadTs) return;
      // Parent message already carries the visitor's first question — only
      // the bot's reply to it still needs to land in the thread.
      await postMessage(env, threadTs, `🤖 Bot (${mode}): ${markdownToSlack(botReply)}`);
      return;
    }
    await postSlackTurn(env, sessionMeta.threadTs, visitorMessage, botReply, mode);
  } catch (err) {
    console.log("slack_log_error", err?.name || "unknown");
  }
}
