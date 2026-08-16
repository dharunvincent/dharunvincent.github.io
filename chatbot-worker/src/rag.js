const SCORE_THRESHOLD = 0.55;
const TOP_K = 5;
const TOPICS = ["career", "relationship", "virtue"];

function detectTopic(message) {
  const lower = message.toLowerCase();
  return TOPICS.find((topic) => lower.includes(topic)) || null;
}

// Embeds the query, searches Vectorize, keeps score > 0.55, and always
// includes chunks from the matching life-advice/<topic> file when the
// visitor's message names a quick-reply topic (career/relationship/virtue) —
// even if those chunks didn't make the similarity cut.
export async function getAdviceContext(env, message) {
  const embedResp = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [message],
  });
  const vector = embedResp.data?.[0];
  if (!vector) return "";

  const results = await env.VECTORIZE.query(vector, {
    topK: TOP_K,
    returnMetadata: "all",
  });

  const matches = (results.matches || []).filter((m) => m.score > SCORE_THRESHOLD);

  const topic = detectTopic(message);
  if (topic) {
    const prefix = `life-advice/${topic}`;
    const alreadyIncluded = new Set(matches.map((m) => m.id));
    // Vectorize has no native "starts with" filter, so pull a wider window
    // of the same query and filter client-side to guarantee topic chunks
    // are included even if they didn't clear the similarity threshold.
    const wideResults = await env.VECTORIZE.query(vector, {
      topK: 20,
      returnMetadata: "all",
    });
    for (const m of wideResults.matches || []) {
      if (
        !alreadyIncluded.has(m.id) &&
        typeof m.metadata?.source === "string" &&
        m.metadata.source.startsWith(prefix)
      ) {
        matches.push(m);
        alreadyIncluded.add(m.id);
      }
    }
  }

  // Cost guardrail: never send more than 5 chunks to Claude.
  matches.length = Math.min(matches.length, TOP_K);

  if (matches.length === 0) return "";

  return matches
    .map((m) => m.metadata?.text)
    .filter(Boolean)
    .join("\n\n---\n\n");
}
