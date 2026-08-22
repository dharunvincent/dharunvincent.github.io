import { appendHumanReply } from "./session-do.js";

const SLACK_API = "https://slack.com/api";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

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

// Phase 3: while a human has taken over (sessionMeta.humanActiveUntil in the
// future), /chat never calls Claude, so only the visitor's line needs to
// land in the thread — Dharun's replies arrive via the Slack thread itself.
export async function logVisitorMessageToSlack(env, { sessionMeta, visitorMessage }) {
  try {
    if (!sessionMeta?.threadTs) return;
    await postMessage(env, sessionMeta.threadTs, `🧑 Visitor: ${visitorMessage}`);
  } catch (err) {
    console.log("slack_log_error", err?.name || "unknown");
  }
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// HMAC-SHA256 of "v0:{timestamp}:{rawBody}" per Slack's signing spec, using
// crypto.subtle.verify (constant-time) rather than a manual string compare.
async function verifySlackSignature(env, rawBody, timestamp, signature) {
  if (!timestamp || !signature) {
    console.log("slack_events_sig_fail", "missing_headers", "timestamp=" + !!timestamp, "signature=" + !!signature);
    return false;
  }

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_MAX_AGE_SECONDS) {
    console.log("slack_events_sig_fail", "stale_timestamp", "age_seconds=" + age);
    return false;
  }

  const match = /^v0=([0-9a-f]+)$/i.exec(signature);
  if (!match) {
    console.log("slack_events_sig_fail", "bad_signature_format");
    return false;
  }

  if (!env.SLACK_SIGNING_SECRET) {
    console.log("slack_events_sig_fail", "no_signing_secret_configured");
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const base = `v0:${timestamp}:${rawBody}`;
  const ok = await crypto.subtle.verify("HMAC", key, hexToBytes(match[1]), new TextEncoder().encode(base));
  console.log("slack_events_sig_check", ok ? "ok" : "mismatch");
  return ok;
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// Records a human (Dharun's) Slack thread reply so /poll can deliver it to
// the visitor, and pauses the bot for this session. Runs inside
// ctx.waitUntil — the /slack/events handler has already returned 200 by the
// time this executes, so a failure here never risks Slack's 3s ack window.
// The write itself goes to the session's Durable Object (session-do.js),
// not KV — DO storage is strongly consistent, so the very next /poll read
// against the same session sees this write immediately.
async function recordHumanReply(env, event) {
  console.log("slack_events_reply_received", "thread_ts=" + event.thread_ts, "text_len=" + (event.text || "").length);
  try {
    const sessionId = await env.CHAT_KV.get(`thread:${event.thread_ts}`);
    if (!sessionId) {
      console.log("slack_events_thread_lookup", "not_found", "thread_ts=" + event.thread_ts);
      return;
    }
    console.log("slack_events_thread_lookup", "found", "sessionId=" + sessionId);

    const result = await appendHumanReply(env, sessionId, event.text || "");
    console.log(
      "slack_events_pending_written",
      "sessionId=" + sessionId,
      "store=durable_object",
      "pending_count=" + result.pendingCount,
      "humanActiveUntil=" + result.humanActiveUntil
    );
  } catch (err) {
    console.log("slack_event_error", err?.name || "unknown", err?.message || "");
  }
}

// POST /slack/events — Slack Events API webhook (Phase 3). Signature
// verification, url_verification handshake, and event_callback → pending
// reply + humanActiveUntil. Notion logging (Phase 4) is not built here.
export async function handleSlackEvents(request, env, ctx) {
  console.log("slack_events_received", "POST /slack/events");
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  const valid = await verifySlackSignature(env, rawBody, timestamp, signature);
  if (!valid) {
    return jsonResponse({ error: "invalid_signature" }, 401);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.log("slack_events_invalid_json");
    return jsonResponse({ error: "invalid_json" }, 400);
  }

  console.log("slack_events_payload_type", payload.type);

  if (payload.type === "url_verification") {
    return jsonResponse({ challenge: payload.challenge }, 200);
  }

  if (payload.type === "event_callback") {
    const event = payload.event || {};
    console.log(
      "slack_events_event",
      "event_type=" + event.type,
      "bot_id=" + (event.bot_id || "none"),
      "thread_ts=" + (event.thread_ts || "none"),
      "channel=" + (event.channel || "none")
    );
    if (event.type === "message" && !event.bot_id && event.thread_ts) {
      ctx.waitUntil(recordHumanReply(env, event));
    } else {
      console.log("slack_events_ignored", "reason=" + (event.bot_id ? "bot_id" : !event.thread_ts ? "no_thread_ts" : "not_message"));
    }
  }

  return jsonResponse({ ok: true }, 200);
}
