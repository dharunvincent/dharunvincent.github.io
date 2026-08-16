const IP_LIMIT = 20; // per hour
const IP_TTL_SECONDS = 2 * 60 * 60; // 2h bucket TTL
const SESSION_LIMIT = 30; // per session lifetime
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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
