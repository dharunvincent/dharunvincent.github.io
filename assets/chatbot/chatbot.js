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
      '<form class="dvbot-input-row" autocomplete="off">' +
      '<input type="text" class="dvbot-input" name="dvbot-chat-msg" id="dvbot-chat-msg" placeholder="Type a message…" maxlength="' +
      MAX_MESSAGE_CHARS +
      '" aria-label="Message" autocomplete="off" autocorrect="on" autocapitalize="sentences" ' +
      'spellcheck="true" inputmode="text" data-lpignore="true" data-1p-ignore data-form-type="other" />' +
      '<button type="submit" class="dvbot-send" aria-label="Send">' +
      '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" aria-hidden="true">' +
      '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      "</svg>" +
      "</button>" +
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

  // The layout viewport's height (captured once, before any keyboard has
  // ever opened) is a stable baseline for "is a keyboard covering part of
  // the screen right now" — comparing against a *live* window.innerHeight
  // read is less reliable, since that can also shift for reasons unrelated
  // to the keyboard (e.g. the browser's own chrome collapsing on scroll).
  const initialInnerHeight = window.innerHeight;

  // Whether the on-screen keyboard is expected to be open. Driven primarily
  // by focus/blur on the input — the one deterministic, immediate signal
  // every mobile browser gives us — rather than only inferring it from
  // visualViewport height, which lags behind the real state while the
  // keyboard animates in/out and was the source of missed/flaky gap fixes.
  let keyboardOpen = false;

  // On-screen keyboards shrink window.visualViewport (not the layout
  // viewport that position:fixed is anchored to), so without this the
  // sheet stays pinned to the bottom of the now-offscreen layout viewport
  // and the keyboard covers the latest message. Re-anchor to the visible
  // viewport instead. While the keyboard is open, the sheet fills the
  // ENTIRE visible viewport (no gap) so the input sits snug above the
  // keyboard with nothing showing behind it; the decorative 8% top gap is
  // only for the closed-keyboard "bottom sheet" look.
  function updateMobileViewportSize() {
    if (!state.isOpen || !isMobileViewport()) {
      overlay.style.top = "";
      overlay.style.bottom = "";
      overlay.style.height = "";
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;

    const fillFull = keyboardOpen || vv.height < initialInnerHeight * 0.85;
    const topGap = fillFull ? 0 : Math.round(vv.height * 0.08);

    // Set both top+height AND explicitly clear `bottom` (rather than
    // relying on the CSS media query's bottom:0 losing an over-constrained
    // tug-of-war) so there's no ambiguity about which edge wins across
    // browser engines.
    overlay.style.bottom = "auto";
    overlay.style.top = `${Math.round(vv.offsetTop + topGap)}px`;
    overlay.style.height = `${Math.round(vv.height - topGap)}px`;
    scrollMessagesToBottom();
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateMobileViewportSize);
    window.visualViewport.addEventListener("scroll", updateMobileViewportSize);
  }
  window.addEventListener("resize", updateMobileViewportSize);

  function settleViewportAfterKeyboardChange() {
    // The keyboard animates in/out over the next several hundred ms on
    // most mobile browsers — re-run the fit and re-scroll a few times as
    // it settles rather than guessing a single delay that won't fit every
    // device/browser combination.
    [0, 50, 150, 300, 500, 800].forEach((ms) =>
      setTimeout(() => {
        updateMobileViewportSize();
        scrollMessagesToBottom();
      }, ms)
    );
  }

  inputEl.addEventListener("focus", () => {
    keyboardOpen = true;
    markActivity();
    settleViewportAfterKeyboardChange();
  });

  inputEl.addEventListener("blur", () => {
    keyboardOpen = false;
    settleViewportAfterKeyboardChange();
  });

  // Native-app-style keyboard dismissal: swiping down or tapping anywhere
  // in the message list (not just the close/✕ button) blurs the input,
  // same as iMessage/WhatsApp/Intercom-style widgets.
  let touchStartY = null;
  messagesEl.addEventListener(
    "touchstart",
    (e) => {
      touchStartY = e.touches[0].clientY;
    },
    { passive: true }
  );
  messagesEl.addEventListener(
    "touchmove",
    (e) => {
      if (touchStartY === null || !keyboardOpen) return;
      const dy = e.touches[0].clientY - touchStartY;
      if (dy > 30) {
        inputEl.blur();
        touchStartY = null;
      }
    },
    { passive: true }
  );
  messagesEl.addEventListener("click", () => {
    if (keyboardOpen) inputEl.blur();
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
    keyboardOpen = false;
    overlay.hidden = true;
    overlay.style.top = "";
    overlay.style.bottom = "";
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
