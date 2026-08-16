(function () {
  "use strict";

  const WORKER_URL = "https://dv-chatbot.dharunvincent.workers.dev";

  const SESSION_KEY = "dvbot_session_id";
  const TRANSCRIPT_KEY = "dvbot_transcript";
  const POLL_INTERVAL_MS = 4000;
  const POLL_IDLE_LIMIT_MS = 5 * 60 * 1000;
  const MAX_MESSAGE_CHARS = 1000;
  const MAX_HISTORY_TURNS = 10;

  const FALLBACK_REPLY =
    "I'm napping right now 😴 — try again in a bit, or reach Dharun through the contact section!";
  const GREETING =
    "Hey there! 👋 I'm Dharun's AI sidekick — ask me anything about his work, skills, or projects. And psst… if you type **help me**, I can even share some life advice straight from Dharun's own experiences. 😉";

  function getOrCreateSessionId() {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (id) return id;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
    id = `dv-${hex}`;
    sessionStorage.setItem(SESSION_KEY, id);
    return id;
  }

  function loadTranscript() {
    try {
      const raw = sessionStorage.getItem(TRANSCRIPT_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveTranscript(transcript) {
    sessionStorage.setItem(TRANSCRIPT_KEY, JSON.stringify(transcript));
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Minimal **bold** support only — enough for the greeting/quick-reply copy.
  function renderInline(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function State() {
    this.sessionId = getOrCreateSessionId();
    this.transcript = loadTranscript();
    this.isOpen = false;
    this.isAwaitingReply = false;
    this.humanActive = false;
    this.pollTimer = null;
    this.lastActivityTs = Date.now();
    this.afterTs = 0;
  }

  const state = new State();

  function buildDom() {
    const launcher = document.createElement("button");
    launcher.className = "dvbot-launcher";
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Chat with Dharun's AI assistant");
    launcher.innerHTML =
      '<span class="dvbot-launcher-pulse" aria-hidden="true"></span>' +
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">' +
      '<rect x="4" y="7" width="16" height="12" rx="4" stroke="currentColor" stroke-width="1.8"/>' +
      '<circle cx="9" cy="13" r="1.3" fill="currentColor"/>' +
      '<circle cx="15" cy="13" r="1.3" fill="currentColor"/>' +
      '<path d="M12 7V3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '<circle cx="12" cy="2.5" r="1.2" fill="currentColor"/>' +
      "</svg>";

    const overlay = document.createElement("div");
    overlay.className = "dvbot-panel";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Chat with Dharun's AI assistant");
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="dvbot-header">' +
      '<span class="dvbot-header-title">Dharun’s AI Sidekick</span>' +
      '<button type="button" class="dvbot-close" aria-label="Close chat">✕</button>' +
      "</div>" +
      '<div class="dvbot-status" hidden></div>' +
      '<div class="dvbot-messages" aria-live="polite"></div>' +
      '<div class="dvbot-typing" hidden><span></span><span></span><span></span></div>' +
      '<form class="dvbot-input-row">' +
      '<input type="text" class="dvbot-input" placeholder="Type a message…" maxlength="' +
      MAX_MESSAGE_CHARS +
      '" aria-label="Message" autocomplete="off" />' +
      '<button type="submit" class="dvbot-send" aria-label="Send">→</button>' +
      "</form>" +
      '<div class="dvbot-footer">Chats may be reviewed by Dharun to improve answers.</div>';

    document.body.appendChild(launcher);
    document.body.appendChild(overlay);

    return { launcher, overlay };
  }

  const { launcher, overlay } = buildDom();
  const messagesEl = overlay.querySelector(".dvbot-messages");
  const typingEl = overlay.querySelector(".dvbot-typing");
  const statusEl = overlay.querySelector(".dvbot-status");
  const formEl = overlay.querySelector(".dvbot-input-row");
  const inputEl = overlay.querySelector(".dvbot-input");
  const closeEl = overlay.querySelector(".dvbot-close");

  function markActivity() {
    state.lastActivityTs = Date.now();
  }

  function appendMessage(role, content, options) {
    options = options || {};
    const msg = { role, content, ts: options.ts || Date.now(), human: !!options.human };
    state.transcript.push(msg);
    saveTranscript(state.transcript);
    renderMessage(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return msg;
  }

  function renderMessage(msg) {
    const row = document.createElement("div");
    row.className =
      "dvbot-msg " + (msg.role === "user" ? "dvbot-msg-user" : "dvbot-msg-bot") + (msg.human ? " dvbot-msg-human" : "");
    if (msg.human) {
      const label = document.createElement("div");
      label.className = "dvbot-msg-label";
      label.textContent = "Dharun (live) 🧑‍💻";
      row.appendChild(label);
    }
    const bubble = document.createElement("div");
    bubble.className = "dvbot-bubble";
    bubble.innerHTML = renderInline(msg.content);
    row.appendChild(bubble);
    messagesEl.appendChild(row);
  }

  function renderQuickReplies() {
    const row = document.createElement("div");
    row.className = "dvbot-quick-replies";
    [
      ["Career", "career"],
      ["Relationship", "relationship"],
      ["Virtue", "virtue"],
    ].forEach(([label, value]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dvbot-quick-reply";
      btn.textContent = label;
      btn.addEventListener("click", () => {
        row.remove();
        sendMessage(value, "advice");
      });
      row.appendChild(btn);
    });
    messagesEl.appendChild(row);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setTyping(isTyping) {
    typingEl.hidden = !isTyping;
    if (isTyping) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setStatus(text) {
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = "";
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
  }

  function setInputEnabled(enabled) {
    inputEl.disabled = !enabled;
    formEl.querySelector(".dvbot-send").disabled = !enabled;
  }

  async function sendMessage(text, explicitMode) {
    const trimmed = text.trim().slice(0, MAX_MESSAGE_CHARS);
    if (!trimmed || state.isAwaitingReply) return;

    markActivity();
    appendMessage("user", trimmed);

    if (!explicitMode && trimmed.toLowerCase().includes("help me")) {
      renderQuickReplies();
    }

    state.isAwaitingReply = true;
    setInputEnabled(false);
    setTyping(true);

    const history = state.transcript
      .filter((m) => !m.human)
      .slice(-MAX_HISTORY_TURNS - 1, -1)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch(`${WORKER_URL}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          message: trimmed,
          mode: explicitMode,
          history,
        }),
      });

      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        appendMessage("assistant", body.reply || FALLBACK_REPLY);
        return;
      }

      if (!res.ok) {
        appendMessage("assistant", FALLBACK_REPLY);
        return;
      }

      const body = await res.json();
      state.humanActive = !!body.humanActive;
      if (state.humanActive) {
        setStatus("Dharun is replying personally… 🧑‍💻");
      } else {
        setStatus(null);
      }
      if (body.reply) {
        appendMessage("assistant", body.reply);
      }
    } catch {
      appendMessage("assistant", FALLBACK_REPLY);
    } finally {
      state.isAwaitingReply = false;
      setInputEnabled(true);
      setTyping(false);
      inputEl.focus();
    }
  }

  async function pollOnce() {
    try {
      const res = await fetch(`${WORKER_URL}/poll?session=${encodeURIComponent(state.sessionId)}&after=${state.afterTs}`);
      if (!res.ok) return;
      const body = await res.json();
      state.humanActive = !!body.humanActive;
      setStatus(state.humanActive ? "Dharun is replying personally… 🧑‍💻" : null);
      (body.messages || []).forEach((m) => {
        appendMessage("assistant", m.content, { ts: m.ts, human: true });
        if (m.ts > state.afterTs) state.afterTs = m.ts;
      });
    } catch {
      // Silent — polling failures shouldn't interrupt the chat experience.
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (Date.now() - state.lastActivityTs > POLL_IDLE_LIMIT_MS) {
        stopPolling();
        return;
      }
      pollOnce();
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  let savedScrollY = 0;

  // overflow:hidden alone doesn't reliably stop iOS Safari from scrolling
  // the page behind a fixed sheet, so pin body in place with position:fixed
  // (restoring the exact scroll offset on unlock) — the CSS
  // body.dvbot-scroll-lock rule is a harmless belt-and-braces fallback.
  function lockBodyScroll(lock) {
    if (lock) {
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.body.classList.add("dvbot-scroll-lock");
      document.body.style.position = "fixed";
      document.body.style.top = `-${savedScrollY}px`;
      document.body.style.width = "100%";
    } else {
      document.body.classList.remove("dvbot-scroll-lock");
      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";
      window.scrollTo(0, savedScrollY);
    }
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // On-screen keyboards shrink window.visualViewport (not the layout
  // viewport that position:fixed is anchored to), so without this the
  // sheet stays pinned to the bottom of the now-offscreen layout viewport
  // and the keyboard covers the latest message. Re-anchor to the visible
  // viewport instead, keeping the same ~8% top-gap proportions.
  function updateMobileViewportSize() {
    if (!state.isOpen || !isMobileViewport()) {
      overlay.style.top = "";
      overlay.style.height = "";
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;
    const topGap = Math.round(vv.height * 0.08);
    overlay.style.top = `${Math.round(vv.offsetTop) + topGap}px`;
    overlay.style.height = `${Math.round(vv.height - topGap)}px`;
    scrollMessagesToBottom();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateMobileViewportSize);
    window.visualViewport.addEventListener("scroll", updateMobileViewportSize);
  }
  window.addEventListener("resize", updateMobileViewportSize);

  inputEl.addEventListener("focus", () => {
    markActivity();
    scrollMessagesToBottom();
    // Keyboard animates in over the next couple hundred ms on most mobile
    // browsers — nudge again once it (and any visualViewport resize) settles.
    setTimeout(scrollMessagesToBottom, 350);
  });

  function openPanel() {
    state.isOpen = true;
    overlay.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    markActivity();
    state.afterTs = Date.now();

    if (state.transcript.length === 0) {
      appendMessage("assistant", GREETING);
    }

    if (isMobileViewport()) lockBodyScroll(true);
    updateMobileViewportSize();
    startPolling();
    closeEl.focus();
    scrollMessagesToBottom();
  }

  function closePanel() {
    state.isOpen = false;
    overlay.hidden = true;
    overlay.style.top = "";
    overlay.style.height = "";
    launcher.setAttribute("aria-expanded", "false");
    lockBodyScroll(false);
    stopPolling();
    launcher.focus();
  }

  launcher.addEventListener("click", () => (state.isOpen ? closePanel() : openPanel()));
  closeEl.addEventListener("click", closePanel);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.isOpen) closePanel();
  });

  formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = inputEl.value;
    inputEl.value = "";
    sendMessage(text);
  });

  // Render any transcript persisted from a previous page (sessionStorage
  // survives navigation within the tab) so reopening the widget doesn't
  // lose history.
  state.transcript.forEach(renderMessage);

  window.addEventListener("DOMContentLoaded", () => {
    launcher.classList.add("dvbot-launcher-intro");
  });
})();
