#!/usr/bin/env node
// Reads knowledge/life-advice/**/*.md (the ADVICE seed corpus) plus any
// Notion "Chatbot Replies" rows with Approved = true (Phase 4 — skipped
// gracefully here if Notion isn't configured yet), chunks everything, and
// POSTs it to the deployed Worker's /admin/reindex, which embeds and
// upserts into Vectorize.
//
// Usage: npm run reindex   (from chatbot-worker/)
// Env (from chatbot-worker/.dev.vars or process.env):
//   WORKER_URL   — defaults to http://127.0.0.1:8787 (wrangler dev)
//   ADMIN_TOKEN  — must match the Worker's ADMIN_TOKEN secret
//   NOTION_API_KEY, NOTION_REPLIES_DB_ID — optional, Phase 4

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(WORKER_DIR, "..");
const LIFE_ADVICE_DIR = path.join(REPO_ROOT, "knowledge", "life-advice");

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

async function loadDevVars() {
  const varsPath = path.join(WORKER_DIR, ".dev.vars");
  const env = {};
  try {
    const text = await readFile(varsPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // .dev.vars not present — rely on process.env only.
  }
  return { ...env, ...process.env };
}

function chunkText(text, source) {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= CHUNK_SIZE) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    if (current) chunks.push(current);
    if (para.length <= CHUNK_SIZE) {
      current = para;
    } else {
      // Paragraph itself exceeds chunk size — hard-split with overlap.
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + CHUNK_SIZE, para.length);
        chunks.push(para.slice(start, end));
        start = end - CHUNK_OVERLAP;
        if (start <= 0 || end === para.length) break;
      }
      current = "";
    }
  }
  if (current) chunks.push(current);

  // Add overlap between consecutive chunks from the same source.
  const overlapped = chunks.map((chunk, i) => {
    if (i === 0) return chunk;
    const prevTail = chunks[i - 1].slice(-CHUNK_OVERLAP);
    return `${prevTail}\n\n${chunk}`;
  });

  return overlapped.map((text, i) => ({
    id: `${source}#${i}`,
    text,
    source,
  }));
}

async function loadLifeAdviceChunks() {
  const files = await readdir(LIFE_ADVICE_DIR);
  const chunks = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(LIFE_ADVICE_DIR, file);
    const text = await readFile(filePath, "utf8");
    const source = `life-advice/${file.replace(/\.md$/, "")}`;
    chunks.push(...chunkText(text, source));
  }
  return chunks;
}

async function loadApprovedNotionChunks(env) {
  if (!env.NOTION_API_KEY || !env.NOTION_REPLIES_DB_ID) {
    console.log("Notion not configured — skipping approved-replies corpus (Phase 4).");
    return [];
  }

  const { Client } = await import("@notionhq/client");
  const notion = new Client({ auth: env.NOTION_API_KEY });

  const chunks = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: env.NOTION_REPLIES_DB_ID,
      filter: { property: "Approved", checkbox: { equals: true } },
      start_cursor: cursor,
    });
    for (const page of res.results) {
      const question = page.properties?.Question?.title?.[0]?.plain_text || "";
      const answer = page.properties?.Answer?.rich_text?.map((t) => t.plain_text).join("") || "";
      if (!question || !answer) continue;
      const text = `Q: ${question}\nDharun's answer: ${answer}`;
      chunks.push(...chunkText(text, `notion/${page.id}`));
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);

  return chunks;
}

async function main() {
  const env = await loadDevVars();
  const workerUrl = env.WORKER_URL || "http://127.0.0.1:8787";
  if (!env.ADMIN_TOKEN) {
    console.error("ADMIN_TOKEN is not set (check chatbot-worker/.dev.vars). Aborting.");
    process.exit(1);
  }

  const lifeAdviceChunks = await loadLifeAdviceChunks();
  const notionChunks = await loadApprovedNotionChunks(env);
  const chunks = [...lifeAdviceChunks, ...notionChunks];

  console.log(`Reindexing ${chunks.length} chunks (${lifeAdviceChunks.length} life-advice, ${notionChunks.length} approved Notion) → ${workerUrl}/admin/reindex`);

  const res = await fetch(`${workerUrl}/admin/reindex`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ chunks }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Reindex failed: ${res.status}`, body);
    process.exit(1);
  }
  console.log(`Done. Upserted ${body.upserted} vectors.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
