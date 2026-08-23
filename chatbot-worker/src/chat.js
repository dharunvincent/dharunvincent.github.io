import { routeMessage } from "./router.js";
import { checkRateLimit } from "./ratelimit.js";
import { getPortfolioKnowledge } from "./knowledge.js";
import { getAdviceContext } from "./rag.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { logChatToSlack, logVisitorMessageToSlack } from "./slack.js";
import { getHumanActiveUntil, setSessionContext } from "./session-do.js";

const MAX_MESSAGE_CHARS = 1000;
const MAX_HISTORY_TURNS = 10;
const MAX_TOKENS = 512;
const CLAUDE_TIMEOUT_MS = 25000;
const SESSION_ID_RE = /^dv-[0-9a-f]{32,}$/;

const FALLBACK_REPLY =
  "I'm napping right now 😴 — try again in a bit, or reach Dharun through the contact section!";
const RATE_LIMIT_REPLY =
  "Whoa, speedy! 🏎️ Give me a minute to catch my breath.";
const HUMAN_ACTIVE_REPLY =
  "Dharun's replying to you personally right now 🧑‍💻 — keep an eye on the chat, his reply will show up here shortly.";

function stripControlChars(str) {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function jsonResponse(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

export async function handleChat(request, env, ctx, corsHeaders) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400, corsHeaders);
  }

  const { sessionId, message, mode: explicitMode, history: rawHistory } = body || {};

  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
    return jsonResponse({ error: "invalid_session" }, 400, corsHeaders);
  }
  if (typeof message !== "string" || message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    return jsonResponse({ error: "invalid_message" }, 400, corsHeaders);
  }

  const cleanMessage = stripControlChars(message).trim();
  const history = Array.isArray(rawHistory)
    ? rawHistory
        .slice(-MAX_HISTORY_TURNS)
        .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
        .map((t) => ({ role: t.role, content: stripControlChars(t.content).slice(0, MAX_MESSAGE_CHARS) }))
    : [];

  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const { limited } = await checkRateLimit(env.CHAT_KV, ip, env.IP_SALT, sessionId);
  if (limited) {
    return jsonResponse({ error: "rate_limited", reply: RATE_LIMIT_REPLY }, 429, corsHeaders);
  }

  // sess:<sessionId> in KV only ever holds { threadTs, createdAt } now —
  // humanActiveUntil lives in the session's Durable Object (session-do.js),
  // which is strongly consistent (KV's eventual consistency was measured
  // to add 15-40+ seconds of lag between a Slack reply and it becoming
  // visible here).
  const sessionMeta = await env.CHAT_KV.get(`sess:${sessionId}`, "json");
  // No sessionMeta means no Slack thread exists yet for this session, so a
  // human can't have taken over — skip the DO round-trip entirely.
  const humanActiveUntil = sessionMeta ? await getHumanActiveUntil(env, sessionId) : 0;
  if (humanActiveUntil > Date.now()) {
    // Human-takeover: a Slack thread reply (via /slack/events) sets
    // humanActiveUntil for 10 minutes. While active, skip Claude entirely —
    // Dharun is replying live in the Slack thread — but still log the
    // visitor's message there so he sees it.
    ctx.waitUntil(logVisitorMessageToSlack(env, { sessionMeta, visitorMessage: cleanMessage }));
    ctx.waitUntil(setSessionContext(env, sessionId, { message: cleanMessage }));
    return jsonResponse({ reply: HUMAN_ACTIVE_REPLY, sessionId, humanActive: true }, 200, corsHeaders);
  }

  const mode = routeMessage(cleanMessage, explicitMode);
  ctx.waitUntil(setSessionContext(env, sessionId, { message: cleanMessage, mode }));

  const systemBlocks = [
    { type: "text", text: SYSTEM_PROMPT(env.PUBLIC_EMAIL), cache_control: { type: "ephemeral" } },
  ];
  if (mode === "portfolio") {
    systemBlocks.push({
      type: "text",
      text: `FULL KNOWLEDGE ABOUT DHARUN:\n${getPortfolioKnowledge()}`,
      cache_control: { type: "ephemeral" },
    });
  }
  if (mode === "advice") {
    const ragContext = await getAdviceContext(env, cleanMessage);
    systemBlocks.push({
      type: "text",
      text: `DHARUN'S RELEVANT ADVICE NOTES:\n${ragContext || "(no matching notes yet)"}`,
    });
  }
  systemBlocks.push({ type: "text", text: `CURRENT MODE: ${mode.toUpperCase()}` });

  let reply;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
        messages: [...history, { role: "user", content: cleanMessage }],
      }),
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.log("anthropic_error", res.status);
      return jsonResponse({ reply: FALLBACK_REPLY, sessionId, humanActive: false }, 200, corsHeaders);
    }

    const data = await res.json();
    reply = data.content?.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (!reply) reply = FALLBACK_REPLY;
  } catch (err) {
    console.log("chat_error", err?.name || "unknown");
    return jsonResponse({ reply: FALLBACK_REPLY, sessionId, humanActive: false }, 200, corsHeaders);
  }

  ctx.waitUntil(
    logChatToSlack(env, { sessionId, sessionMeta, visitorMessage: cleanMessage, botReply: reply, mode })
  );

  return jsonResponse({ reply, sessionId, humanActive: false }, 200, corsHeaders);
}
