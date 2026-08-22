const IP_LIMIT = 20; // per hour
const IP_TTL_SECONDS = 2 * 60 * 60; // 2h bucket TTL
const SESSION_LIMIT = 30; // per session lifetime
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// /poll runs on a 4s client-side interval (~15/min), so its limits are
// per-minute buckets, not the per-hour/lifetime buckets /chat uses.
const POLL_SESSION_LIMIT = 20; // per minute, per session
const POLL_IP_LIMIT = 60; // per minute, per IP hash (covers multiple tabs/sessions)
const POLL_TTL_SECONDS = 65;

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hashIp(ip, salt) {
  return sha256Hex(`${ip}${salt}`);
}

async function incrementCounter(kv, key, ttlSeconds) {
  const current = await kv.get(key);
  const count = current ? parseInt(current, 10) + 1 : 1;
  await kv.put(key, String(count), { expirationTtl: ttlSeconds });
  return count;
}

// Returns { limited: boolean, reason: "ip" | "session" | null }
export async function checkRateLimit(kv, ip, salt, sessionId) {
  const ipHash = await hashIp(ip, salt);
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const ipKey = `rl:ip:${ipHash}:${hourBucket}`;
  const sessKey = `rl:sess:${sessionId}`;

  const ipCount = await incrementCounter(kv, ipKey, IP_TTL_SECONDS);
  if (ipCount > IP_LIMIT) return { limited: true, reason: "ip" };

  const sessCount = await incrementCounter(kv, sessKey, SESSION_TTL_SECONDS);
  if (sessCount > SESSION_LIMIT) return { limited: true, reason: "session" };

  return { limited: false, reason: null };
}

// Returns { limited: boolean, reason: "ip" | "session" | null }
export async function checkPollRateLimit(kv, ip, salt, sessionId) {
  const ipHash = await hashIp(ip, salt);
  const minuteBucket = Math.floor(Date.now() / (60 * 1000));
  const ipKey = `rl:poll:ip:${ipHash}:${minuteBucket}`;
  const sessKey = `rl:poll:sess:${sessionId}:${minuteBucket}`;

  const ipCount = await incrementCounter(kv, ipKey, POLL_TTL_SECONDS);
  if (ipCount > POLL_IP_LIMIT) return { limited: true, reason: "ip" };

  const sessCount = await incrementCounter(kv, sessKey, POLL_TTL_SECONDS);
  if (sessCount > POLL_SESSION_LIMIT) return { limited: true, reason: "session" };

  return { limited: false, reason: null };
}
