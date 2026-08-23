const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const VALID_TAGS = ["career", "relationship", "virtue", "portfolio", "other"];
const MAX_PROP_CHARS = 2000; // Notion rich_text/title item limit

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

// Phase 4: save Dharun's Slack thread reply—and the visitor question it
// answers—to the Notion "Chatbot Replies" DB, Approved left unchecked so he
// can curate before it ever reaches the advice index (see scripts/reindex.js).
// Best-effort only: callers run this inside ctx.waitUntil(), so any failure
// here is logged and swallowed, never surfaced to Slack or the visitor.
export async function saveHumanReplyToNotion(env, { sessionId, question, answer, mode }) {
  if (!env.NOTION_API_KEY || !env.NOTION_REPLIES_DB_ID) {
    console.log("notion_save_skipped", "not_configured");
    return;
  }

  const tag = VALID_TAGS.includes(mode) ? mode : "other";

  try {
    const res = await fetch(`${NOTION_API}/pages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.NOTION_API_KEY}`,
        "notion-version": NOTION_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: env.NOTION_REPLIES_DB_ID },
        properties: {
          Question: {
            title: [{ text: { content: (question || "").slice(0, MAX_PROP_CHARS) } }],
          },
          Answer: {
            rich_text: [{ text: { content: (answer || "").slice(0, MAX_PROP_CHARS) } }],
          },
          Session: {
            rich_text: [{ text: { content: sessionId || "" } }],
          },
          Date: { date: { start: todayISODate() } },
          Tags: { multi_select: [{ name: tag }] },
          Approved: { checkbox: false },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.log("notion_save_error", res.status, errBody.slice(0, 200));
      return;
    }

    console.log("notion_save_ok", "session=" + sessionId);
  } catch (err) {
    console.log("notion_save_error", err?.name || "unknown");
  }
}
