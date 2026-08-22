const HUMAN_ACTIVE_MS = 10 * 60 * 1000;

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// One Durable Object instance per chat session (env.SESSION_DO.idFromName(sessionId)).
// A DO's storage is strongly consistent and single-threaded per instance, so a
// write here is visible to the very next read against the same instance —
// no propagation delay like Workers KV. This replaces the pending:<sessionId>
// and sess:<sessionId>.humanActiveUntil KV keys, which measured 15-40+
// second gaps between a Slack reply landing and it becoming visible to /poll.
export class SessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/append-reply" && request.method === "POST") {
      const { content } = await request.json();
      const pending = (await this.state.storage.get("pending")) || [];
      pending.push({ from: "human", content: content || "", ts: Date.now() });
      await this.state.storage.put("pending", pending);
      const humanActiveUntil = Date.now() + HUMAN_ACTIVE_MS;
      await this.state.storage.put("humanActiveUntil", humanActiveUntil);
      return json({ ok: true, pendingCount: pending.length, humanActiveUntil }, 200);
    }

    if (url.pathname === "/poll" && request.method === "GET") {
      const after = Number(url.searchParams.get("after")) || 0;
      const pending = (await this.state.storage.get("pending")) || [];
      const toReturn = pending.filter((m) => m.ts > after);
      const toKeep = pending.filter((m) => m.ts <= after);
      if (toReturn.length > 0) {
        await this.state.storage.put("pending", toKeep);
      }
      const humanActiveUntil = (await this.state.storage.get("humanActiveUntil")) || 0;
      return json({ messages: toReturn, humanActive: humanActiveUntil > Date.now() }, 200);
    }

    if (url.pathname === "/human-active" && request.method === "GET") {
      const humanActiveUntil = (await this.state.storage.get("humanActiveUntil")) || 0;
      return json({ humanActiveUntil }, 200);
    }

    return json({ error: "not_found" }, 404);
  }
}

function getStub(env, sessionId) {
  const id = env.SESSION_DO.idFromName(sessionId);
  return env.SESSION_DO.get(id);
}

export async function appendHumanReply(env, sessionId, content) {
  const stub = getStub(env, sessionId);
  const res = await stub.fetch("https://session-do/append-reply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  return res.json();
}

export async function pollSession(env, sessionId, after) {
  const stub = getStub(env, sessionId);
  const res = await stub.fetch(`https://session-do/poll?after=${after}`);
  return res.json();
}

export async function getHumanActiveUntil(env, sessionId) {
  const stub = getStub(env, sessionId);
  const res = await stub.fetch("https://session-do/human-active");
  const body = await res.json();
  return body.humanActiveUntil || 0;
}
