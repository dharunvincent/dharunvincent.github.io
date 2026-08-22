import { handleChat } from "./chat.js";

const EMBED_BATCH_SIZE = 100;

function corsHeadersFor(request, allowedOrigins) {
  const origin = request.headers.get("origin") || "";
  const isAllowed =
    allowedOrigins.includes(origin) ||
    (origin.startsWith("http://localhost:") && allowedOrigins.some((o) => o.startsWith("http://localhost:")));

  return {
    "access-control-allow-origin": isAllowed ? origin : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    vary: "origin",
  };
}

function json(body, status, corsHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

async function handlePoll(request, env, corsHeaders) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session");
  if (!sessionId || !/^dv-[0-9a-f]{32,}$/.test(sessionId)) {
    return json({ error: "invalid_session" }, 400, corsHeaders);
  }
  // Phase 1 has no Slack live-takeover yet (that's Phase 3), so there is
  // never anything pending. This keeps the widget's poll loop functional
  // without needing the Slack/session infrastructure this early.
  return json({ messages: [], humanActive: false }, 200, corsHeaders);
}

async function handleReindex(request, env, corsHeaders) {
  const auth = request.headers.get("authorization") || "";
  if (auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ error: "unauthorized" }, 401, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400, corsHeaders);
  }

  const chunks = Array.isArray(body?.chunks) ? body.chunks : [];
  if (chunks.length === 0) {
    return json({ error: "no_chunks" }, 400, corsHeaders);
  }

  let upserted = 0;
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embedResp = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: batch.map((c) => c.text),
    });
    const vectors = batch.map((c, idx) => ({
      id: c.id,
      values: embedResp.data[idx],
      metadata: { text: c.text, source: c.source },
    }));
    await env.VECTORIZE.upsert(vectors);
    upserted += vectors.length;
  }

  return json({ upserted }, 200, corsHeaders);
}

export default {
  async fetch(request, env, ctx) {
    const allowedOrigins = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim());
    const corsHeaders = corsHeadersFor(request, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/chat" && request.method === "POST") {
        return await handleChat(request, env, ctx, corsHeaders);
      }
      if (url.pathname === "/poll" && request.method === "GET") {
        return await handlePoll(request, env, corsHeaders);
      }
      if (url.pathname === "/admin/reindex" && request.method === "POST") {
        return await handleReindex(request, env, corsHeaders);
      }
    } catch (err) {
      console.log("worker_error", err?.name || "unknown");
      return json({ error: "internal_error" }, 500, corsHeaders);
    }

    return json({ error: "not_found" }, 404, corsHeaders);
  },
};
