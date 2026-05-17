'use strict';

const { Client }           = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { marked }           = require('marked');
const fs                   = require('fs');
const path                 = require('path');

// ── Config ────────────────────────────────────────────────────
const notion = new Client({ auth: process.env.NOTION_API_KEY });
const n2m    = new NotionToMarkdown({ notionClient: notion });

const DB_ID    = process.env.NOTION_DATABASE_ID;
const ROOT     = path.join(__dirname, '..');
const POSTS    = path.join(ROOT, 'blogs', 'posts');
const INDEX    = path.join(ROOT, 'blogs', 'index.html');
const MARKER_S = '<!-- BLOG_POSTS_START -->';
const MARKER_E = '<!-- BLOG_POSTS_END -->';

marked.use({ breaks: true, gfm: true });

// ── Helpers ───────────────────────────────────────────────────
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getText(arr) {
  return (arr || []).map(t => t.plain_text).join('').trim();
}

function slugify(str) {
  return str.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

function fmtDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function readTime(html) {
  const words = html.replace(/<[^>]*>/g, ' ').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

// ── Fetch all published posts ─────────────────────────────────
async function fetchPosts() {
  const pages = [];
  let cursor;

  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      filter: { property: 'Published Date', checkbox: { equals: true } },
      sorts:  [{ property: 'Published Date', direction: 'descending' }],
      start_cursor: cursor,
      page_size: 100
    });
    pages.push(...res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return pages;
}

// ── Extract page properties ───────────────────────────────────
function extract(page) {
  const p       = page.properties;
  const title   = getText(p.Title?.title || []);
  const slug    = getText(p.Slug?.rich_text || []) || slugify(title);
  const dateStr = p['Published Date']?.date?.start || null;
  const tags    = (p.Tags?.multi_select || []).map(t => t.name);
  const excerpt = getText(p.Excerpt?.rich_text || []);
  const coverProp = p['Cover Image'];
  const cover   =
    coverProp?.url ||
    coverProp?.files?.[0]?.external?.url ||
    coverProp?.files?.[0]?.file?.url ||
    page.cover?.external?.url ||
    page.cover?.file?.url ||
    null;
  return { id: page.id, title, slug, dateStr, tags, excerpt, cover };
}

// ── Blog card HTML ────────────────────────────────────────────
function buildCard(post, rt) {
  const { title, slug, dateStr, tags, excerpt } = post;
  const tagHtml = tags
    .map(t => `<span class="blog-tag">${esc(t)}</span>`)
    .join('');

  return `<article class="blog-card card reveal">
  <a href="/blogs/posts/${esc(slug)}/" class="blog-card-link" aria-label="Read: ${esc(title)}">
    <div class="blog-card-top">
      ${tagHtml ? `<div class="blog-card-tags">${tagHtml}</div>` : ''}
      <h2 class="blog-card-title">${esc(title)}</h2>
      ${excerpt ? `<p class="blog-card-excerpt">${esc(excerpt)}</p>` : ''}
    </div>
    <div class="blog-card-meta">
      ${dateStr ? `<time class="blog-card-date" datetime="${esc(dateStr)}">${fmtDate(dateStr)}</time><span aria-hidden="true">·</span>` : ''}
      <span>${rt} min read</span>
      <span class="blog-card-arrow" aria-hidden="true">→</span>
    </div>
  </a>
</article>`;
}

// ── Individual post page HTML ─────────────────────────────────
function buildPostPage(post, content, rt) {
  const { title, slug, dateStr, tags, excerpt, cover } = post;
  const tagHtml   = tags.map(t => `<span class="blog-post-tag">${esc(t)}</span>`).join('');
  const coverHtml = cover
    ? `<div class="blog-post-cover-wrap"><img src="${esc(cover)}" alt="${esc(title)}" class="blog-post-cover" loading="lazy" /></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="description" content="${esc(excerpt || title)}" />
  <meta name="author" content="Dharun Vincent R" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://dharunvincent.com/blogs/posts/${esc(slug)}/" />
  <title>${esc(title)} – Dharun Vincent</title>
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(excerpt || title)}" />
  <meta property="og:url" content="https://dharunvincent.com/blogs/posts/${esc(slug)}/" />
  <meta property="og:site_name" content="Dharun Vincent" />
  <meta property="og:image" content="${cover ? esc(cover) : 'https://dharunvincent.com/og-image.png'}" />
  ${dateStr ? `<meta property="article:published_time" content="${esc(dateStr)}" />` : ''}
  <meta http-equiv="X-Frame-Options" content="DENY" />
  <meta http-equiv="X-Content-Type-Options" content="nosniff" />
  <meta name="referrer" content="strict-origin-when-cross-origin" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preload"
    href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Lora:ital,wght@0,400;0,500;1,400&family=DM+Mono:wght@400;500&display=swap"
    as="style" onload="this.onload=null;this.rel='stylesheet'" />
  <noscript>
    <link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Lora:ital,wght@0,400;0,500;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
  </noscript>
  <link rel="stylesheet" href="/assets/css/style.css" />
  <style>
    :root {
      --orange:      #E85D1A;
      --orange-dim:  rgba(232,93,26,0.10);
      --orange-glow: rgba(232,93,26,0.30);
      --surface:     rgba(0,0,0,0.05);
      --border:      rgba(0,0,0,0.10);
      --muted:       rgba(26,26,26,0.55);
    }
    html, body { background: #F5F4EE; color: #1A1A1A; }
    body::before { opacity: .2; }
    ::-webkit-scrollbar-track { background: #F5F4EE; }
    ::-webkit-scrollbar-thumb { background: var(--orange); }
    .nav-inner.scrolled { background: rgba(245,244,238,0.82) !important; border-color: rgba(0,0,0,0.12) !important; }
    .nav-inner { background: rgba(245,244,238,0.82); border: 1px solid rgba(0,0,0,0.10); }
    .nav-logo { color: #1A1A1A; }
    .nav-links a { color: rgba(26,26,26,0.55); }
    .nav-links a:hover, .nav-links a.active { color: #1A1A1A; background: rgba(0,0,0,0.06); }
    .hamburger { background: rgba(0,0,0,0.06); border-color: rgba(0,0,0,0.12); }
    .hamburger span { background: rgba(26,26,26,0.8); }
    #mobile-nav { background: rgba(245,244,238,0.92); border-color: rgba(0,0,0,0.12); }
    .mobile-nav-links a { color: rgba(26,26,26,0.7); }
    .mobile-nav-links a:hover { background: rgba(0,0,0,0.05); border-color: rgba(0,0,0,0.1); color: #1A1A1A; }
    footer { border-top-color: rgba(0,0,0,0.08); }
    footer p { color: rgba(26,26,26,0.3); }
  </style>
  <script type="text/javascript">
    (function(c,l,a,r,i,t,y){
      c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
      t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
      y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window,document,"clarity","script","wagqxp6f56");
  </script>
</head>
<body>
  <div id="cursor-dot"  aria-hidden="true"></div>
  <div id="cursor-ring" aria-hidden="true"></div>
  <div id="mobile-nav-backdrop" onclick="closeMobileNav()"></div>

  <nav id="mobile-nav" aria-label="Mobile navigation">
    <div class="mobile-nav-links">
      <a href="/vibe-coding/" onclick="closeMobileNav()"><span class="nav-num">01</span>Vibe Coding</a>
      <a href="/#experience"  onclick="closeMobileNav()"><span class="nav-num">02</span>My Experience</a>
    </div>
    <div class="mobile-nav-divider"></div>
    <div class="mobile-nav-footer">
      <a href="/#contact" onclick="closeMobileNav()">Get in Touch</a>
    </div>
  </nav>

  <nav id="navbar" aria-label="Main navigation">
    <div class="nav-inner" id="nav-inner">
      <a href="/" class="nav-logo" aria-label="Dharun Vincent – home">Dharun Vincent</a>
      <div class="nav-links" role="list">
        <a href="/vibe-coding/" role="listitem">Vibe Coding</a>
        <a href="/blogs/"       role="listitem" class="active">Blogs</a>
        <a href="/#contact"     role="listitem">Contact</a>
      </div>
      <div class="mobile-nav-right">
        <a href="/" class="mobile-nav-cta">Home</a>
        <button class="hamburger" id="hamburger" aria-label="Open navigation menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
  </nav>

  <main class="blog-post-main" id="main-content">
    <div class="blog-post-container">
      <a href="/blogs/" class="blog-back-link">
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M19 12H5M12 5l-7 7 7 7"/>
        </svg>
        Back to Blog
      </a>

      <article class="blog-post" itemscope itemtype="https://schema.org/BlogPosting">
        <header class="blog-post-header">
          <div class="blog-post-meta">
            ${dateStr ? `<time datetime="${esc(dateStr)}" itemprop="datePublished">${fmtDate(dateStr)}</time><span aria-hidden="true">·</span>` : ''}
            <span>${rt} min read</span>
          </div>
          <h1 class="blog-post-title" itemprop="headline">${esc(title)}</h1>
          ${tagHtml ? `<div class="blog-post-tags" aria-label="Tags">${tagHtml}</div>` : ''}
        </header>

        ${coverHtml}

        <div class="blog-post-content" itemprop="articleBody">
${content}
        </div>
      </article>

      <div class="blog-post-footer">
        <a href="/blogs/" class="blog-back-link">
          <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
          Back to Blog
        </a>
      </div>
    </div>
  </main>

  <footer>
    <p>&copy; <span id="year"></span> Dharun Vincent R · All Rights Reserved</p>
  </footer>

  <script src="/assets/js/main.js"></script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  if (!DB_ID) throw new Error('NOTION_DATABASE_ID env var is required');

  console.log('Fetching posts from Notion…');
  const pages = await fetchPosts();
  console.log(`Found ${pages.length} published post(s)`);

  fs.mkdirSync(POSTS, { recursive: true });

  const cards = [];

  for (const page of pages) {
    const post = extract(page);
    if (!post.title) { console.warn('Skipping page with no title'); continue; }
    console.log(`  → ${post.title} (${post.slug})`);

    const mdBlocks = await n2m.pageToMarkdown(page.id);
    const md       = n2m.toMarkdownString(mdBlocks)?.parent || '';
    const html     = marked.parse(md);
    const rt       = readTime(html);

    const postDir = path.join(POSTS, post.slug);
    fs.mkdirSync(postDir, { recursive: true });
    fs.writeFileSync(path.join(postDir, 'index.html'), buildPostPage(post, html, rt), 'utf8');

    cards.push(buildCard(post, rt));
  }

  // Inject cards into the blog index between markers
  const injected = cards.length
    ? cards.join('\n')
    : '<p class="blog-empty-msg">No posts yet — check back soon.</p>';

  let indexHtml = fs.readFileSync(INDEX, 'utf8');
  const si = indexHtml.indexOf(MARKER_S);
  const ei = indexHtml.indexOf(MARKER_E);
  if (si === -1 || ei === -1) throw new Error('blogs/index.html is missing BLOG_POSTS_START / BLOG_POSTS_END markers');

  indexHtml =
    indexHtml.slice(0, si + MARKER_S.length) +
    '\n' + injected + '\n' +
    indexHtml.slice(ei);

  fs.writeFileSync(INDEX, indexHtml, 'utf8');
  console.log(`Done — ${cards.length} post(s) synced`);
}

main().catch(err => { console.error(err); process.exit(1); });
