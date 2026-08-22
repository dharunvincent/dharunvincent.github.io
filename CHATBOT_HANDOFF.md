# CHATBOT_HANDOFF.md — Project State & Continuation Guide

> **Instructions for the AI assistant reading this document:**
> You are taking over an in-progress project: an AI chatbot for the portfolio
> website **dharunvincent.com**. Read this file fully, then read
> **CHATBOT_SPEC.md** (the authoritative technical spec, in the repo root),
> then explore the codebase on the branch the owner gives you. After that you
> should be able to continue exactly where the previous session left off —
> the owner should not have to re-explain anything.
>
> **About the owner:** Dharun is a Product Manager with NO software
> development background. He has proven excellent at: following precise
> terminal instructions, UAT with screenshots, and making product decisions.
> Communicate accordingly — explain technical steps plainly, give exact
> commands to copy-paste (without inline comments after them — his zsh treats
> `#` comments as arguments), pause at manual checkpoints, and never assume
> he can debug code himself. He reviews and approves; you build.

---

## 1. PROJECT SUMMARY

An AI chatbot ("**Dharun's AI Sidekick**") embedded on every page of the
portfolio site. Frontend widget lives in the site repo (GitHub Pages / static
vanilla HTML/CSS/JS); backend is a **Cloudflare Worker** calling the
**Anthropic API (claude-haiku-4-5)**.

**Hybrid three-mode brain** (routed per message in `src/router.js`):
- **PORTFOLIO** — questions about Dharun → **full-context** (all
  `knowledge/about.md`, `projects.md`, `faq.md` in the cached system prompt).
  Deliberately NOT RAG, to avoid retrieval misses on facts.
- **ADVICE** — "help me" → Career / Relationship / Virtue quick-reply
  buttons → **RAG**: Workers AI embeddings (`@cf/baai/bge-base-en-v1.5`,
  768-dim) + **Vectorize** index `portfolio-rag` (cosine), seeded from
  `knowledge/life-advice/*.md`. Will later also index owner-approved Notion
  replies (Phase 4).
- **GENERAL** — anything else reasonable → ≤3 short lines of generic help,
  ALWAYS ending with an invitation to email `dharun@dharunvincent.com`.

Full architecture, security rules, prompts, API contracts, phase plan, and
acceptance checklists are in **CHATBOT_SPEC.md — treat it as authoritative.**
One deviation from spec already agreed: the ADVICE router keyword
`"should i"` was REMOVED (it misrouted the spec's own GENERAL test case,
"What should I do to become a Product Manager?"). Do not re-add it.

---

## 1.5 ARCHITECTURE RATIONALE & INTEGRATION MAP (read before touching infra)

### Why Cloudflare exists in this project at all
The website is a **static site on GitHub Pages** — it can serve files but
CANNOT run backend code. A chatbot needs a backend because the Anthropic API
key must never be exposed in frontend/browser code (anyone could steal it
from dev tools). The solution: the site stays on GitHub Pages untouched, and
a **Cloudflare Worker** acts as the entire backend, hosted separately.

**Flow of every message:**
`Visitor's browser (widget on GitHub Pages / Netlify preview)`
→ `fetch POST https://dv-chatbot.dharunvincent.workers.dev/chat`
→ `Worker: CORS check → rate limit (KV) → route mode → build context
   (bundled knowledge OR Vectorize query) → call Anthropic API with the
   secret key → return reply`
→ `browser renders it`.

The frontend and backend are fully decoupled: if the Worker dies, the
website is unaffected (widget shows a friendly "napping" fallback). The
Worker is deployed with `wrangler deploy` from `chatbot-worker/` — it does
NOT follow git branches; whatever is on the local machine at deploy time
goes live. Frontend changes ship via git → Netlify preview → (after merge)
GitHub Pages.

### Why Cloudflare specifically (decision already made — don't relitigate)
Chosen over Vercel/Netlify Functions/Supabase/AWS because it's the only
platform where ALL needed pieces are first-party on a no-credit-card free
tier: Workers (backend, 100k req/day), **Vectorize** (vector DB for RAG),
**Workers AI** (free embeddings), **KV** (session/rate-limit store), always-on
public HTTPS URL (needed later for Slack webhooks; free tiers elsewhere
sleep). Cloudflare-specific code is deliberately isolated in `rag.js` and
`ratelimit.js` for portability. The owner's Cloudflare account: free plan,
2FA enabled, the site's DNS is NOT on Cloudflare (skip any "add a site"
onboarding — GitHub Pages + Netlify handle the site).

### Cloudflare pieces in use
- **Worker `dv-chatbot`** — the backend app; public address comes from the
  account-level subdomain `dharunvincent.workers.dev` (registered during
  setup; one per account, shared by all future Workers).
- **KV `CHAT_KV`** — key-value store: sessions (`sess:<id>`), Slack thread
  mapping (`thread:<ts>`, Phase 2+), pending human replies
  (`pending:<id>`, Phase 3), rate-limit counters (`rl:ip:<sha256>`,
  `rl:sess:<id>`). All entries carry TTLs (30d / 24h).
- **Vectorize `portfolio-rag`** — vector index (768-dim, cosine) for the
  ADVICE corpus only. Populated via `scripts/reindex.js` →
  `POST /admin/reindex` (Bearer ADMIN_TOKEN) → Workers AI embeddings →
  upsert.
- **Workers AI binding `AI`** — runs `@cf/baai/bge-base-en-v1.5` for
  embeddings (free tier; no OpenAI/Voyage dependency).
- **wrangler.toml** — single config: bindings, `ALLOWED_ORIGINS` (CORS
  allowlist), `PUBLIC_EMAIL`, and a `[[rules]] type="Text"` block that lets
  the Worker bundle `knowledge/*.md` files as imported strings at deploy
  time (this is WHY the portfolio knowledge requires a `wrangler deploy` to
  update).

### Anthropic Console integration (billing & key — the owner set all this up)
- The chatbot does NOT use the owner's Claude Pro subscription — Pro cannot
  fund API calls. It uses the **Anthropic Console (console.anthropic.com)**,
  a separate account with **prepaid credits** ($5 loaded, **auto-reload
  OFF** → hard spending ceiling; API simply stops if exhausted).
- Layered cost caps: org-level monthly spend limit ($5) → dedicated
  **workspace `portfolio-chatbot`** with its own $3/month cap + $2 email
  alert → code-level caps (model `claude-haiku-4-5`, `max_tokens: 512`,
  history ≤10 turns, ≤5 RAG chunks, input ≤1000 chars, per-IP-hash and
  per-session rate limits) → **prompt caching** on the big stable system
  blocks (`cache_control: {type:"ephemeral"}`) cuts repeat-token cost ~90%.
- The **API key was created INSIDE the `portfolio-chatbot` workspace** (so
  the workspace cap governs it). The Worker calls
  `https://api.anthropic.com/v1/messages` directly with
  `x-api-key: env.ANTHROPIC_API_KEY` + `anthropic-version: 2023-06-01`.
- **Key custody protocol (hard rule):** the key value lives in exactly two
  places — Cloudflare's encrypted secret store (via
  `npx wrangler secret put ANTHROPIC_API_KEY`, owner pastes at the hidden
  prompt) and the local gitignored `chatbot-worker/.dev.vars` (for
  `wrangler dev`). It NEVER appears in chat, repo files, or command-line
  arguments. If it's ever exposed, rotate: delete key in Console → create
  new one in the same workspace → re-run `wrangler secret put` → update
  `.dev.vars`. (This already happened once early on and was handled exactly
  this way.)
- Other Worker secrets: `ADMIN_TOKEN` (guards `/admin/reindex`), `IP_SALT`
  (rate-limit IP hashing) — generated randomly during setup. Phase 2+ will
  add `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`,
  `NOTION_API_KEY`, `NOTION_REPLIES_DB_ID`.

### SECURITY MODEL — how keys/credentials are stored and attacks prevented
This project's security is architectural, not instructional — preserve it.

**Where every credential lives (and doesn't):**
| Credential | Stored in | NEVER in |
|---|---|---|
| `ANTHROPIC_API_KEY` | Cloudflare encrypted secret store (write-only: uploadable via `wrangler secret put`, readable by the running Worker as `env.*`, NOT viewable in any dashboard/CLI afterwards) + local gitignored `.dev.vars` | repo, git history, chat transcripts, command-line args (hidden prompt keeps it out of shell history), frontend code |
| `ADMIN_TOKEN`, `IP_SALT` | same two places | same |
| Slack/Notion tokens (Phase 2+) | same pattern when added | same |
| Cloudflare account access | owner's browser OAuth session (created by `npx wrangler login`) — machine-local token, protected by account password + **2FA** | the repo; no Cloudflare API key exists in this project |
| Anthropic/GitHub/Slack/Notion accounts | password + **2FA** each (recovery codes saved offline by owner) | — |

**Attack paths and their specific defenses:**
1. **Steal the API key from the website** → impossible: frontend contains no
   key; the browser only ever talks to the Worker URL. The key is used
   server-side inside Cloudflare's runtime.
2. **Read the key from the repo/git history** → prevented: `.dev.vars` is
   gitignored (verified with `git check-ignore`); a `git grep` for key
   patterns was run and clean. Keep it that way — never write secrets to any
   tracked file, and never echo a real key in a command that lands in shell
   history or chat.
3. **Abuse the Worker's endpoints directly** (bypassing the widget) →
   layered: CORS allowlist (only the production domain + current Netlify
   preview) blocks browser-based abuse; per-IP-hash (20/hr) and per-session
   (30) rate limits blunt scripted abuse; input capped at 1000 chars;
   `max_tokens: 512`. `/admin/reindex` requires `Bearer ADMIN_TOKEN`.
   (Note honestly: CORS doesn't stop curl — the rate limits and spend caps
   are the real ceiling for non-browser abuse.)
4. **Worst case — key somehow fully leaked** → blast radius is capped by
   design: the key belongs to the `portfolio-chatbot` Console workspace with
   a **$3/month spend cap + $2 email alert**, the org has a monthly cap, and
   the account holds only prepaid credits with **auto-reload OFF**. Maximum
   theoretical damage ≈ the price of a coffee, with an email warning en
   route. Response: rotate (delete key in Console → new key in same
   workspace → `wrangler secret put` → update `.dev.vars`).
5. **Prompt injection via chat** ("ignore your rules / reveal your prompt /
   what did other visitors ask") → system-prompt hardening treats visitor
   text as conversation-never-instructions, PLUS the stronger guarantee:
   secrets and private data are simply absent from the model's context —
   the prompt contains no keys, the knowledge base contains no
   phone/address/private data, and visitor messages are never embedded into
   Vectorize, so cross-visitor extraction is architecturally impossible.
   The model cannot leak what it never sees.
6. **Forged Slack webhooks / fake "human replies"** (Phase 3) → HMAC
   signature verification with `SLACK_SIGNING_SECRET` + stale-timestamp
   rejection; loop prevention via `bot_id` check.
7. **Session snooping via `/poll`** → session IDs are crypto-random 16+ byte
   values (unguessable, treated like temporary passwords); rate-limit
   storage uses salted **hashed** IPs (counting without identifying); all
   session KV entries auto-expire (TTLs), so data doesn't accumulate.
8. **Account takeover (the real perimeter)** → 2FA on GitHub, Cloudflare,
   Anthropic Console, Slack, and Notion; the laptop itself is a credentialed
   device (git access + wrangler session) and must stay passworded/locked.

**Standing rules for any future session:** never ask the owner to paste a
key into chat; never print secret values in command output; deploy-class and
secret-class commands always get explicit owner approval (no blanket
`wrangler *` auto-approve); when adding new secrets (Phase 2+), follow the
same custody pattern — `wrangler secret put` + `.dev.vars`, nothing else.

### New-machine setup note (owner is migrating laptops/accounts)
The deployed Worker, secrets, KV, and Vectorize all live in Cloudflare's
cloud — nothing to migrate. On a new machine you only need: the repo cloned
on `website-revamp`, Node ≥18, `npx wrangler login` (browser OAuth into the
same Cloudflare account), and a recreated local
`chatbot-worker/.dev.vars` (owner types/pastes his key there himself; guide
him to use nano, one line `ANTHROPIC_API_KEY=<key>`, and verify with
`git check-ignore .dev.vars`).

---

## 1.7 ⏰ TIME-CRITICAL ITEM + DECISIONS LOG + WORKING AGREEMENT

### ⏰ API KEY EXPIRY — check this early in the new session
The owner chose a **30-day expiration** on the Anthropic API key (created
~Aug 16, 2026 → expires ~mid-September 2026). When it expires, the key
silently dies: the website stays fine, but the chatbot shows its "napping"
fallback for every visitor with NO alert. First actions for the new
session: ask the owner to verify the exact expiry date in the Console and
set a recurring calendar reminder ~2 days before it. If the chatbot ever
"mysteriously stops working," an expired key is the FIRST thing to check.

#### 🔑 KEY RENEWAL RUNBOOK (owner-facing — complete, ~5 minutes, works
even without any AI assistant; assistant: walk him through this verbatim
when the time comes)

**Part A — Create the new key (in the browser):**
1. Go to **console.anthropic.com** and log in (this is the Console account,
   separate from claude.ai).
2. Open **API Keys** (in Settings / left sidebar).
3. Click **Create Key**. In the dialog, set the **workspace selector to
   `portfolio-chatbot`** — this is critical; it's what keeps the $3/month
   spend cap on the key. Name it anything (e.g. `cloudflare-worker-sept`).
   Choose the expiration you want (30/90 days — your call).
4. The key (`sk-ant-…`) is shown ONCE. Copy it. Park it temporarily in your
   password manager or Notes — NOT in any chat, NOT in any repo file.

**Part B — Give it to the deployed chatbot (in the terminal):**
5. Open Terminal on the laptop that has the repo and run, one line at a
   time (no comments after commands):
   ```
   cd ~/dharunvincent.website/chatbot-worker
   npx wrangler login
   ```
   (Skip `wrangler login` if this machine is already logged in — it will
   just say so. Otherwise a browser tab opens → click Allow.)
6. ```
   npx wrangler secret put ANTHROPIC_API_KEY
   ```
   Run this EXACTLY as written — `ANTHROPIC_API_KEY` is the label, not the
   key. At the hidden **"Enter a secret value:"** prompt, paste the new key
   (nothing appears on screen — that's normal) and press Enter. Wait for
   **"✨ Success! Uploaded secret ANTHROPIC_API_KEY"**. This overwrites the
   old value; NO redeploy is needed — the live Worker uses the new key
   immediately.
   If the paste feels fumbled: Ctrl+C and run the command again; it's
   overwrite-safe any number of times.

**Part C — Update the local test file:**
7. ```
   nano .dev.vars
   ```
   Replace the key after `ANTHROPIC_API_KEY=` with the new one (one line,
   no quotes, no spaces). Save: Ctrl+O, Enter. Exit: Ctrl+X.
   (If `.dev.vars` doesn't exist on this machine, create it with that
   single line.) Verify it's git-ignored:
   ```
   git check-ignore .dev.vars
   ```
   — it must print the file path. If it prints nothing, STOP and add
   `chatbot-worker/.dev.vars` to .gitignore before doing anything else.

**Part D — Clean up:**
8. Back in the Console → API Keys: **delete/disable the OLD key**.
9. Delete the key from your password manager/Notes parking spot.
10. Test: open the website, send the chatbot one message, confirm a real
    reply (not the napping fallback).
11. Set the next calendar reminder (2 days before the new expiry).

**Troubleshooting:** chatbot still napping after renewal → (a) confirm the
Success message appeared in step 6; (b) confirm the new key was created
INSIDE the `portfolio-chatbot` workspace and that workspace still has
credit/limit headroom (Console → workspace → Limits); (c) check the
Console's Cost/Usage page — if calls show errors, re-run step 6 carefully.

### Decisions already made — do NOT relitigate or "improve" these
- **Hosting stays as-is:** site on GitHub Pages, backend on Cloudflare
  Workers. Do not propose migrating the site or the backend.
- **Hybrid brain is deliberate:** full-context for portfolio facts, RAG only
  for advice, general mode with email CTA. Do not convert portfolio mode to
  RAG or vice versa.
- **Router keyword "should i" stays REMOVED** (spec conflict, resolved with
  owner).
- **Chromium/headless-browser testing was explicitly rejected** — owner does
  all real-browser testing himself on the Netlify preview. Never install
  browsers; backend sanity tests are curl-only against /chat.
- **Wrangler's "install Cloudflare skills" offer was declined** — decline
  again if re-prompted.
- **Model is claude-haiku-4-5** for cost; don't upgrade without the owner
  asking.
- **PR-based delivery:** every phase lands as a PR the owner merges
  personally. Claude never merges anything.

### Working agreement (the "rules of engagement" the owner runs sessions by)
This pattern was used all through Phase 1 — keep it:
1. Before writing code for any new phase/feature: present a short plan and
   WAIT for the owner's OK.
2. At every manual step (dashboard clicks, logins, secret entry): STOP,
   give exact instructions, wait. Commands must be copy-paste clean with NO
   trailing `#` comments (owner's zsh treats them as arguments — this
   caused a real error once).
3. Secrets discipline per the Security Model — gitignore before secrets,
   keys never in chat.
4. Never modify existing site files beyond the agreed widget tags.
5. Small commits, clear messages, all on the working branch
   (`website-revamp` currently; future phases may use fresh branches off
   main after PR #14 merges — owner decides).
6. Finish each phase with: push → `gh pr create` (or hand the owner the
   GitHub compare link if gh is unavailable) → owner tests on the Netlify
   preview → owner merges.
7. Stop at phase boundaries; never start the next phase unprompted.
8. Bug-fix loop: owner reports (usually screenshots from his device matrix:
   iPhone Safari, iPhone Chrome, Android Chrome, desktop) → you diagnose,
   fix, list what could regress, push → remind him to hard-refresh /
   private tab → he re-tests. Note: Chrome DevTools mobile emulation does
   NOT reproduce the mobile keyboard class of bugs — never claim a mobile
   fix is "verified" from emulation alone.

### Small facts that matter (misc log)
- `PUBLIC_EMAIL = dharun@dharunvincent.com` (confirmed by owner; used in the
  GENERAL-mode CTA).
- The site already has a Notion integration for blog sync
  (`scripts/sync-notion.js`) — Phase 4's `NOTION_API_KEY` may reuse that
  integration's token if granted access to the new "Chatbot Replies" DB,
  and the nightly-reindex GitHub Action should mirror the existing blog-sync
  workflow pattern.
- The site has a custom cursor element — its z-index must stay ABOVE all
  `.dvbot-` widget elements (this broke twice; fixed systemically in
  Round 3).
- ALLOWED_ORIGINS currently: production domain, www, localhost:8788,
  localhost:3000, and the pinned preview-14 origin.
- Owner's Anthropic Console, Cloudflare, GitHub, Slack, and Notion accounts
  all have 2FA enabled; recovery codes saved offline.

---

## 2. CURRENT STATE (what exists and works)

### Deployed / live
- **Worker deployed:** `https://dv-chatbot.dharunvincent.workers.dev`
  (Worker name `dv-chatbot`, account subdomain `dharunvincent.workers.dev`)
- **KV namespace:** `CHAT_KV`, id `15c0683f1e494d9d90c24ac85e8ebfab`
- **Vectorize index:** `portfolio-rag` (768 dims, cosine), binding
  `VECTORIZE`, seeded with placeholder advice content
- **Secrets set on the Worker** (values NOT in repo, never ask for them):
  `ANTHROPIC_API_KEY` (owner set it himself — never overwrite it or ask him
  to paste the key into chat), `ADMIN_TOKEN`, `IP_SALT`, and as of Phase 2
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID` (confirmed
  present via `wrangler secret list` — names only, values are write-only and
  were never read). Notion secrets NOT yet set (Phase 4). Local `.dev.vars`
  exists, gitignored, and as of Session 7 only holds `ANTHROPIC_API_KEY`,
  `ADMIN_TOKEN`, `IP_SALT` — the Slack secrets are NOT mirrored there yet
  (Cloudflare secrets can't be read back once set, so they must be re-typed
  by the owner locally if `wrangler dev`/local curl testing against Slack is
  ever needed).
- **All three modes verified working** against the deployed Worker, plus:
  rate limiting (20/hr/IP-hash, 30/session), CORS, guardrails
  (personal-data refusal, cross-visitor privacy refusal, prompt-injection
  deflection). No secrets in git (verified).

### Repo / branch state
- **PR #14** (`website-revamp` → `main`) merged by the owner on 22 Aug 2026
  — Phase 1 live. **PR #15** (`phase-2-slack` → `main`) merged by the owner
  on 22 Aug 2026 — Phase 2 (Slack logging) live. Phase 3 work happens on a
  fresh branch off `main` — same rule applies: never commit/push/merge to
  `main` directly; every phase lands as a PR the owner merges personally.
- **Netlify** is connected to the repo: every PR gets a deploy-preview URL
  in a bot comment. Current preview:
  `https://deploy-preview-14--dharunwebsite.netlify.app` (Netlify site name:
  `dharunwebsite`). This preview origin was added to the Worker's CORS
  allowlist (`ALLOWED_ORIGINS` in wrangler.toml) — note it is pinned to
  preview **14**; a new PR number would need the allowlist updated or a
  wildcard pattern for `deploy-preview-*--dharunwebsite.netlify.app`.
- Widget tags are wired into `index.html`, `blogs/index.html`, all blog post
  pages, the Notion sync template, and (after a bug fix) the `vibe-coding/`
  pages — an audit pass added them everywhere.
- `knowledge/about.md`, `projects.md`, and `faq.md` now contain the owner's
  **real content** (uploaded via GitHub, verified clean of placeholders and
  phone numbers — see Session 7). `knowledge/life-advice/*.md` (career,
  relationship, virtue) are still PLACEHOLDER content — advice mode is fully
  wired up but not yet fed real material.

### Workflow conventions established (keep following these)
- Owner tests on real devices via the **Netlify preview** (not local):
  device matrix = iPhone Safari, iPhone Chrome, Android Chrome, desktop.
  He reports bugs (often with screenshots); you fix, commit, push to
  `website-revamp`; the preview rebuilds; he re-tests. Remind him to
  hard-refresh / use a private tab (mobile browsers cache aggressively).
- Small commits with clear messages. Ask before deviating from spec.
- Owner approves each file edit / command (manual approve mode). Deploy-class
  and secret-class commands always get explicit approval; never request
  blanket wrangler approval.
- Secrets hygiene is a hard rule: keys are set by the owner directly via
  `wrangler secret put` / `.dev.vars`; they never pass through chat. (An
  early key WAS accidentally pasted into a chat and was immediately rotated —
  maintain this discipline.)
- Cost guardrails active on the Anthropic side: $5 prepaid (auto-reload
  OFF), org monthly limit, dedicated Console workspace `portfolio-chatbot`
  with $3/month cap + $2 email alert. Model `claude-haiku-4-5`,
  `max_tokens: 512`, prompt caching on the portfolio context.

---

## 3. BUG HISTORY (all found via owner's UAT; all fixed unless noted)

**Round 1 (first preview test):**
1. Chat window auto-opened on page load → fixed: launcher-icon-first, window
   opens only on click, default closed.
2. Mobile: ✕ close button did nothing → fixed (shared stacking/pointer cause
   with #3).
3. Desktop: clicks passed under/through the window → fixed (z-index /
   pointer-events / stacking).
4. No greeting — only endless typing dots → fixed: greeting is hardcoded
   client-side, rendered instantly on first open; typing indicator only
   during in-flight requests. (Root cause was compounded by missing CORS for
   the Netlify preview origin — also fixed then.)

**Round 2 (mobile UX):**
1. Desktop: the site's **custom cursor** rendered underneath the chat window
   (clicks worked; visual cursor hidden) → fixed via z-index.
2. Mobile: scrolling the chat scrolled the page behind → fixed: body scroll
   lock + `overscroll-behavior: contain`.
3. Mobile: keyboard open cropped the last message → fixed: visualViewport
   sizing + auto-scroll to latest.
4. Mobile: disclaimer line clipped at right edge → fixed: smaller font,
   centered, wraps, padded.

**Round 3 (cosmetics):**
1. Send-button arrow not centered in the orange circle → fixed (flex
   centering).
2. Custom cursor hid under the LAUNCHER icon too (same disease, new element)
   → fixed **systemically**: cursor z-index above ALL `.dvbot-` elements.
3. Design tweak: send arrow stroke made modestly bolder (~25–40% thicker
   stroke, round caps — deliberately subtle).

**Round 4 (page coverage + keyboard, iOS-focused):**
1. Launcher missing on the Vibe Coding page → fixed + full repo audit added
   tags to every public page/template (absolute paths `/assets/chatbot/...`).
2. Input tap ZOOMED the whole page and stayed zoomed (WebKit <16px rule) →
   fixed: input font-size ≥16px (+ viewport meta safety). **This fix works —
   don't rework it.**
3. Keyboard-open white gap + browser autofill icons (key/card/location) →
   fixed: autofill-suppressing attributes (`autocomplete="off"`, neutral
   name like `dvbot-chat-msg`, `inputmode="text"`), visualViewport
   resize/scroll handling, backdrop coverage.
4. Dark `color-scheme` declared so system keyboard/accessory UI renders dark.
5. New interaction added: swipe-down on messages AND tap-outside-input both
   dismiss the keyboard, with smooth height restore.
   - **Accepted limitation (owner knows):** the slim iOS/Android system
     accessory bar with the keyboard-dismiss chevron cannot be removed by a
     website — only blended via dark color-scheme.

**Round 5:**
1. iPhone Chrome: ✕ close icon too small vs Android → fix requested:
   consistent size + ≥44×44px touch target.
2. Android Chrome: sheet resized above keyboard but page content bled
   through between sheet and keyboard → fixed via exact
   visualViewport-height coverage.

**Round 6 — ✅ CLOSED (Session 7, 22 Aug 2026):**
- Android Chrome: after the round 5 fix, the **input bar (text box + send +
  disclaimer) disappeared when the keyboard is open**. Root cause identified:
  the viewport meta tag's `interactive-widget=overlays-content` stopped
  Android Chrome from shrinking `window.visualViewport` when the keyboard
  opened, so `updateMobileViewportSize()` in `chatbot.js` never fired and the
  round-6 CSS fix in `chatbot.css` never triggered. Fix: changed
  `interactive-widget=overlays-content` → `interactive-widget=resizes-content`
  in the viewport meta tag across every HTML file/template (`index.html`,
  `blogs/index.html`, all blog post pages, `vibe-coding/index.html`, and the
  blog template in `scripts/sync-notion.js`). No changes to `chatbot.js` or
  `chatbot.css` were needed.

---

## 3.5 SESSION LOG

### Session 7, 22 Aug 2026
- **Android keyboard bug (Round 6) root-caused and fixed** — see Round 6
  entry in §3 above for the full mechanism. One-line fix per file, `chatbot.js`
  and `chatbot.css` untouched.
- **Knowledge base went live**: `knowledge/about.md`, `projects.md`, and
  `faq.md` now hold the owner's real bio/experience/projects/FAQ content
  (uploaded directly via GitHub). Checked clean of PLACEHOLDER text and phone
  numbers, and confirmed wired into `chatbot-worker/src/knowledge.js` +
  covered by the `wrangler.toml` Text bundling rule. `knowledge/life-advice/*.md`
  are still placeholders — advice mode works, just not fed real content yet.
- **Greeting trimmed**: removed the "And psst… type **help me**…" sentence
  from `GREETING` in `chatbot.js` until real advice content exists, so the
  bot doesn't advertise a feature with placeholder answers. Advice mode
  itself (routing, quick-reply buttons, Vectorize RAG) is untouched and still
  fully wired — only the greeting hint was hidden.
- **Portfolio routing fixed for named entities**: `"Tell me about the R21
  feature"` was falling through to GENERAL mode because `router.js`'s
  `PORTFOLIO_PATTERNS` only matched generic references (dharun/he/his/your
  work/hire/resume/blog), not named projects. Added a small
  `PORTFOLIO_ENTITIES` keyword list (r21, offline download, upi autopay,
  ottplay, uncle john, experience bank, hbo max, discovery+, warner bros,
  robosoft, ai sidekick) checked after the existing patterns. Verified fixed
  against the live Worker for R21, Uncle John, and discovery+ questions.
- **CORS confirmed**: `https://dharunvincent.com` and
  `https://www.dharunvincent.com` were already present in `ALLOWED_ORIGINS`
  alongside the pinned Netlify preview origin — no change was needed.
- **PR #14 merged by the owner**; Phase 1 is live on `main` / production.
- **⏰ API key expiry**: confirmed expiry **15 Sep 2026**. A Slack reminder
  is scheduled in **#anthropic-key-status** for **13 Sep 2026** (2 days
  before) — see the Key Renewal Runbook in §1.7 above when that fires.
- **No test suite exists** in this repo — `npm test` has no script defined
  at root or in `chatbot-worker/package.json`. All verification so far has
  been curl smoke tests against the deployed `/chat` endpoint plus the
  owner's manual device UAT.

### Session 8, 22 Aug 2026
- **Phase 2 shipped and merged**: PR #15 (`phase-2-slack` → `main`) merged
  by the owner. Slack session logging is live in production. See §4.5 above
  for the full current spec of what it does and how to verify it.
- Two follow-up fixes landed on `phase-2-slack` before merge: (1) the first
  turn's bot reply was missing from the Slack thread — fixed so it posts as
  the first threaded reply under the parent, without duplicating the
  visitor's first message; (2) bot replies showed raw `**markdown**` in
  Slack — fixed with a `markdownToSlack()` converter. Emoji labels
  (`🧑 Visitor:` / `🤖 Bot (mode):`) were added last for scannability.
- **Slack app details** confirmed and recorded in §4.5: app name
  `Dharun Chatbot`, private channel `#website-chats` (ID `C0BRJCCG9AB`),
  three secrets (`SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `SLACK_CHANNEL_ID`) confirmed present in Cloudflare via
  `wrangler secret list`. Local `.dev.vars` still does not have the Slack
  values — flagged as a standing gap for whenever local Slack-side testing
  is needed.
- Phase 3 (live human takeover) is next — see §4 Next Steps.

### Session 9, 22 Aug 2026
- **Phase 3 built**: `POST /slack/events`, a real `GET /poll` (was a stub),
  and the `/chat` human-active path. Full spec in §4.6 above. Diagnostic
  `console.log` lines added throughout `/slack/events` so `wrangler tail`
  shows exactly where a request stops (never logs message content, only
  thread_ts/session id/text length/event type, per spec rule 8).
- **Mid-build process note**: an in-flight edit to this file was rejected by
  the owner, which paused the session before `deploy`/`commit`/`push` ran —
  the code itself was already correct in the working tree at that point.
  Confirmed via `git status`/`git log` and fixed by deploying, committing,
  and pushing what was already written; nothing was lost. Lesson: an
  uncommitted-but-correct working tree and a "nothing shipped" remote can
  both be true at once — check `git status` before assuming code is broken
  when a live test fails.
- **Live diagnostic session** run with `npx wrangler tail`:
  - ✅ **Polling confirmed working with real traffic**: ~4000–4200ms between
    consecutive `GET /poll` calls, captured from both
    `deploy-preview-16--dharunwebsite.netlify.app` and `dharunvincent.com`
    directly. The CORS wildcard pattern from Phase 2 (§4.5) is confirmed
    working against a real preview origin, not just by code review.
  - ⚠️ **Slack → Worker delivery NOT confirmed**: despite the owner
    completing the Event Subscriptions dashboard steps (Request URL,
    `message.groups` subscription, reinstall), zero requests from Slack's
    servers reached `/slack/events` during the entire diagnostic session —
    not even the `url_verification` handshake. A manual test curl to the
    same route was correctly captured and correctly rejected (missing
    signature), proving the tail capture and the code both work; it proves
    nothing about whether Slack is actually calling the endpoint. This is
    the standing open item for next session — see §4.6 step 5 for the
    exact re-check order.

### Session 10, 22 Aug 2026
- **Phase 3 root cause found and fixed by the owner**: **Socket Mode was
  enabled on the Slack app**, which makes Slack ignore the Events API
  Request URL entirely and try to deliver over a websocket instead — this
  is why `/slack/events` received zero requests across all of Session 9's
  diagnostics despite every dashboard step looking correct. Turning Socket
  Mode off resolved it; Phase 3 is now confirmed working end-to-end. Full
  writeup and the other two setup gotchas (mandatory reinstall after adding
  `message.groups`; backgrounded-tab polling throttling) are in §4.6.
- **Widget improvement**: added a `visibilitychange` listener in
  `chatbot.js` that fires one immediate poll when the tab regains focus, so
  a reply doesn't sit unseen for up to ~60s behind the browser's background
  timer throttling.
- PR #17 updated with this fix and the handoff notes.

### Session 11, 22 Aug 2026
- **Polling reworked from fixed-interval to activity-aware**, replacing
  Session 10's `visibilitychange`-only patch with a proper three-state
  scheduler (Active/Asleep/Wake) — full design in §4.6. 1s cadence while
  active, complete stop (not throttled ticks) after 20s idle or on
  hidden/closed, immediate catch-up poll on any wake trigger, and an
  in-flight guard so a slow response never gets joined by an overlapping
  request.
- **Raised `/poll` rate limits** in `src/ratelimit.js` to match: 20/min →
  75/min per session, 60/min → 200/min per IP-hash. The old limits were
  sized for the flat 4s cadence (~15/min) and would have started
  rate-limiting a single continuously-active visitor under the new 1s
  cadence (worst case 60/min) after roughly 20 seconds.
- PR #17 updated again with this rework.

---

## 4. NEXT STEPS (in order)

1. **Phase 4 — Notion learning loop** (current phase): "Chatbot Replies" DB
   (Question / Answer / Session / Date / Tags / **Approved checkbox**),
   owner-approved rows only get embedded into Vectorize on reindex. Visitor
   messages are NEVER embedded — this is a privacy invariant, see spec §3.
2. **Housekeeping backlog** (small, do opportunistically):
   - Owner may want the API key rotated periodically — see the expiry note
     in Session 7 above.
   - Consider a nightly GitHub Action for reindex (mirrors the existing
     Notion blog-sync workflow).
   - Real content still needed for `knowledge/life-advice/*.md` (career,
     relationship, virtue) — currently placeholder.
   - No automated test suite exists in this repo (`npm test` has no script
     at root or in `chatbot-worker/`). Verification is manual: curl smoke
     tests against `/chat`, and the owner's real-device UAT matrix.
   - GitHub flagged 1 high-severity Dependabot vulnerability on `main` (seen
     during the Phase 2 PR push) — not yet looked into.

---

## 4.5 PHASE 2 — SLACK LOGGING (✅ LIVE — PR merged to `main`)

**What it does:** one-way session logging to a private Slack channel, no
live takeover yet (that's Phase 3). Lives in `chatbot-worker/src/slack.js`,
wired into `chat.js` via `ctx.waitUntil()` so a Slack outage never blocks or
fails the visitor's reply.

**Slack app / channel:**
- Slack app name: **`Dharun Chatbot`**.
- Private channel: **`#website-chats`**, channel ID **`C0BRJCCG9AB`**.
- Secrets confirmed set on the Worker via Cloudflare (`wrangler secret list`
  — names only, values are write-only and were never read by any assistant):
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`.
- **Local `.dev.vars` does NOT yet contain the Slack values** — only
  `ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `IP_SALT` are there. If local
  `wrangler dev` testing or a local curl against the Slack API is ever
  needed, the owner has to add the three Slack values himself (same custody
  pattern used for `ANTHROPIC_API_KEY`: `nano .dev.vars`, never paste into
  chat) — Cloudflare secrets can't be read back once set.

**Message format (final, after two follow-up fixes this phase):**
- **New session** (no `sess:<id>` KV record yet): posts one **parent**
  message — `"🆕 New chat — session <id>\n🧑 *Visitor:* <first message>"` —
  then, once the reply is ready, posts `"🤖 Bot (<mode>): <reply>"` as the
  first threaded reply. Stores `sess:<id> → { threadTs, createdAt }` and the
  reverse lookup `thread:<ts> → sessionId` in `CHAT_KV` (30-day TTL).
- **Every later turn**: two threaded replies — `"🧑 Visitor: <message>"` then
  `"🤖 Bot (<mode>): <reply>"` — mode (portfolio/advice/general) visible on
  every bot line.
- Bot replies are run through `markdownToSlack()` before posting (converts
  `**bold**` → Slack's `*bold*`, `*italic*` → `_italic_`) so Claude's
  markdown renders correctly in Slack instead of showing raw asterisks.
  Visitor messages are posted as-is (plain text from the widget).
- Only message text + mode ever reach Slack — no IP, IP hash, or other
  session metadata.
- CORS was generalized alongside this so every future Netlify PR preview
  works without an `ALLOWED_ORIGINS` edit: `wrangler.toml`'s
  `ALLOWED_ORIGINS` now has `https://deploy-preview-*--dharunwebsite.netlify.app`
  (glob) instead of a pinned preview number, and `corsHeadersFor()` in
  `src/index.js` matches `*` patterns via a small regex helper.

**How to verify:**
1. `cd chatbot-worker && npx wrangler deploy`.
2. Send `POST /chat` requests with a fresh `dv-` session id (Origin header =
   a value in `ALLOWED_ORIGINS`, e.g. `https://dharunvincent.com`).
3. In `#website-chats`: 1 message in a session → parent + 1 threaded bot
   reply. 2 messages → parent + 1 (turn-1 bot reply) + 2 (turn-2 visitor +
   bot) = 3 threaded replies total, and so on.
4. Verification against the live Slack API (`conversations.history`) needs
   `SLACK_BOT_TOKEN`, which per the note above isn't in local `.dev.vars` —
   the owner has verified this manually in Slack each time so far.
5. `git grep -iE "sk-ant|xoxb"` should stay clean — no Slack token ever
   belongs in a tracked file.

---

## 4.6 PHASE 3 — LIVE HUMAN TAKEOVER (✅ VERIFIED WORKING, branch `phase-2-slack`)

**What it does:** lets Dharun reply to a visitor live by replying in the
Slack thread; the bot pauses for that session for 10 minutes and the
visitor's widget shows his reply within ~4s. New route `POST /slack/events`
and a real `GET /poll` (Phase 1/2 had a stub that always returned empty). No
Notion write yet — that's Phase 4.

**`POST /slack/events`** (`src/slack.js` → `handleSlackEvents`, wired in
`src/index.js`, reachable regardless of CORS/Origin — Slack sends none):
- Verifies Slack's signature: HMAC-SHA256 of `v0:{timestamp}:{rawBody}` with
  `SLACK_SIGNING_SECRET`, checked via `crypto.subtle.verify` (constant-time);
  rejects missing headers, timestamps older than 5 minutes, or a bad
  signature — all with a specific `console.log` reason (see Diagnostics
  below). Invalid signature → 401 before any payload parsing.
- `type: "url_verification"` → echoes `{ challenge }`.
- `type: "event_callback"` with `event.type === "message"`: ignores it if
  `event.bot_id` is set (loop prevention) or there's no `thread_ts` (only
  thread replies count). Otherwise, inside `ctx.waitUntil()`: looks up
  `thread:<thread_ts>` → `sessionId`, appends `{ from: "human", content, ts }`
  to `pending:<sessionId>` (24h TTL), and sets
  `sess:<sessionId>.humanActiveUntil = now + 10 min`.
- Always returns 200 immediately — verification + type routing happens
  before the `ctx.waitUntil` call, so the ack isn't delayed by KV latency.
- **Diagnostics**: every step logs a specific `console.log` line (never
  message content — only thread_ts, session id, text *length*, event type,
  ignore reason) so `npx wrangler tail` shows exactly where a request
  stopped: `slack_events_received` → `slack_events_sig_fail`/`sig_check` →
  `slack_events_payload_type` → `slack_events_event` →
  `slack_events_ignored` OR `slack_events_thread_lookup` →
  `slack_events_pending_written` → `slack_events_human_active_set`.

**`GET /poll?session=<id>&after=<ms>`** (`src/index.js` → `handlePoll`):
- Validates session id format, rate-limited via `checkPollRateLimit()` in
  `src/ratelimit.js` — **75/min/session, 200/min/IP-hash** (raised in
  Session 11 to accommodate the 1s active-polling cadence below; the old
  20/min/60/min buckets were sized for the original fixed 4s interval and
  would have started rate-limiting a single active visitor after ~20
  seconds).
- Returns `pending:<sessionId>` entries newer than `after`, then clears just
  those returned entries from KV.
- Includes `humanActive: true|false` on every response.
- **Confirmed working with real traffic** (Session 9) at the original fixed
  cadence; Session 11 replaced that cadence with the activity-aware
  scheduler below (not yet re-verified live as of this writing — see §5).

**`/chat` change:** when `humanActiveUntil` is in the future, Claude is
never called. The visitor's message is still logged to the Slack thread
(`logVisitorMessageToSlack()`, `ctx.waitUntil`-wrapped), and the response
carries a short static reply — *"Dharun's replying to you personally right
now 🧑‍💻 — keep an eye on the chat, his reply will show up here shortly."* —
instead of `reply: null` as the original spec draft had it.

**Widget polling — activity-aware scheduler (reworked Session 11,
`assets/chatbot/chatbot.js`):** replaced the original fixed-interval
polling (Phase 1 scaffolding: flat 4s, 5-minute idle cutoff) with a
three-state scheduler:
- **Active** — polls `/poll` every 1s (`ACTIVE_POLL_INTERVAL_MS`) while the
  visitor has been active (`keydown`, `pointermove`, `scroll`, `touchstart`,
  `touchmove` — listened for on `document` with `{ passive: true, capture:
  true }`, so page-level activity counts, not just interaction with the
  widget itself; `capture: true` is needed because `scroll` doesn't bubble)
  within the last 20s (`ACTIVITY_IDLE_MS`).
- **Asleep** — after 20s with no activity, or the instant
  `document.visibilityState` becomes `"hidden"`, or the panel closes,
  polling stops completely: `stopPolling()` clears the interval entirely,
  it isn't just skipped ticks. An idle or backgrounded visitor costs zero
  requests.
- **Wake** — any activity event, `visibilitychange` back to `"visible"`,
  or the panel opening all call `wake()`: one immediate `pollOnce()` plus
  restarting the Active interval. `wake()` only acts when currently asleep
  (`!state.pollTimer` check) — once active, high-frequency events like
  `pointermove`/`scroll` just refresh the activity timestamp and return, so
  they can't flood `/poll` with redundant immediate calls.
- **Guard** — a module-level `pollInFlight` flag in `pollOnce()` means a
  slow response is never joined by a second overlapping request; the next
  tick just no-ops until the in-flight one resolves.

### ⚠️ Setup gotchas (read before touching Slack Event Subscriptions again)

1. **Socket Mode must be OFF.** If Socket Mode is enabled on the Slack app,
   Slack ignores the Events API **Request URL entirely** and delivers
   events over a websocket instead — `/slack/events` will never receive
   anything, with no error anywhere to point at it. This was the actual
   root cause of an extended diagnostic session (Sessions 9–10) where
   `wrangler tail` showed zero incoming requests despite a correctly
   verified Request URL, `message.groups` subscribed, and a reinstalled
   app. **Check App Settings → Socket Mode is Off** before assuming
   anything else is broken.
2. **Reinstalling the app after adding `message.groups` is mandatory, not
   optional.** Saving the new bot event subscription alone does not
   activate it — Slack requires a reinstall (the permissions
   re-confirmation prompt) before it actually starts delivering that event
   type. Skipping this step looks identical to a signature or routing bug
   from the Worker side: silence, no errors, nothing in the logs.

**How to verify:**
1. `cd chatbot-worker && npx wrangler deploy`.
2. Slack app dashboard (`Dharun Chatbot`) → confirm **Socket Mode is Off**
   → Event Subscriptions → Request URL =
   `https://dv-chatbot.dharunvincent.workers.dev/slack/events` → subscribe
   to bot event `message.groups` → Save → **reinstall the app** (mandatory,
   see gotcha #2).
3. From the widget, send a message so a session thread exists in
   `#website-chats`. Reply directly in that thread in Slack.
4. With the tab focused and active (typing/scrolling/moving the pointer
   within the last 20s), the visitor's widget should show the reply labeled
   "Dharun (live) 🧑‍💻" within ~1s, plus the "Dharun is replying
   personally… 🧑‍💻" status line. If idle >20s or the tab was backgrounded,
   the reply arrives on the next Wake trigger (any activity, or refocusing
   the tab).
5. Confirm the Asleep behavior in devtools: leave the panel open and idle
   for >20s (no keyboard/pointer/scroll/touch input) — the `/poll` calls in
   the Network tab should stop entirely, then resume immediately on the
   next keypress/scroll/pointer move.
6. Confirm the Guard: throttle the network in devtools and watch that
   overlapping `GET /poll` requests never appear even under the 1s
   interval.
7. Sending another visitor message during the 10-minute `humanActiveUntil`
   window does not get a Claude reply — only the static "Dharun's replying
   to you personally…" line — and still appears in the Slack thread.
8. `SLACK_SIGNING_SECRET` needed to construct a locally-signed test request
   is a Cloudflare secret (write-only) and is not in local `.dev.vars` —
   same standing gap as `SLACK_BOT_TOKEN` (§4.5). Not needed for the
   verification above since real Slack signs its own requests correctly.

---

## 5. HOW TO START THE NEW SESSION

Suggested first actions for the assistant, in order:
1. Read this file, then CHATBOT_SPEC.md fully.
2. `git fetch origin --prune`, check out `main`, confirm it's current, then
   check out (or create) the branch for the phase in progress — Phase 1
   lived on `website-revamp`; Phase 2 lives on `phase-2-slack`; each future
   phase gets its own fresh branch off `main`. Review recent commit history
   and the current state of `assets/chatbot/`, `chatbot-worker/src/`, and
   `knowledge/`.
3. Report to the owner: a short status summary of where the current phase's
   PR stands + flag the API key expiry check from section 1.7 (renews
   ~15 Sep 2026 — see Session 7).
4. Ask the owner ONE thing: whatever open question blocks the next step
   (e.g. did his device re-test pass, is a PR ready to merge) — then proceed
   down the Next Steps list above.

Guardrails to carry forward: work only on the current phase's feature
branch; never merge; never touch `main` directly; never put secrets in
files/chat/git; don't ask the owner to share keys — if a secret is needed
locally that isn't in `.dev.vars`, ask the owner to add it there himself;
keep the spec's privacy and cost rules; small commits; stop at phase
boundaries and let the owner decide when to start the next phase.
