(function () {
  "use strict";

  const WORKER_URL = "https://dv-chatbot.dharunvincent.workers.dev";

  const SESSION_KEY = "dvbot_session_id";
  const TRANSCRIPT_KEY = "dvbot_transcript";
  const ACTIVE_POLL_INTERVAL_MS = 1000;
  const ACTIVITY_IDLE_MS = 20 * 1000;
  const MAX_MESSAGE_CHARS = 1000;
  const MAX_HISTORY_TURNS = 10;

  const FALLBACK_REPLY =
    "I'm napping right now 😴 — try again in a bit, or reach Dharun through the contact section!";
  const GREETING =
    "Hey there! 👋 I'm Dharun's AI sidekick — ask me anything about his work, skills, or projects.";

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
      '<button type="button" class="dvbot-close" aria-label="Close chat">' +
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
      "</svg>" +
      "</button>" +
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

  // Guards against a slow network causing overlapping requests — a poll
  // already in flight is never joined by another one.
  let pollInFlight = false;

  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
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
    } finally {
      pollInFlight = false;
    }
  }

  function isPageVisible() {
    return document.visibilityState !== "hidden";
  }

  // Active: poll every 1s while the visitor has been active in the last
  // 20s. The interval itself checks freshness on every tick (rather than a
  // separate timeout) so a single clock drives both "am I still active"
  // and "is it time to poll".
  function startPolling() {
    stopPolling();
    if (!state.isOpen || !isPageVisible()) return;
    state.pollTimer = setInterval(() => {
      if (!state.isOpen || !isPageVisible() || Date.now() - state.lastActivityTs > ACTIVITY_IDLE_MS) {
        stopPolling();
        return;
      }
      pollOnce();
    }, ACTIVE_POLL_INTERVAL_MS);
  }

  // Asleep: no interval running at all — not just skipped ticks — so an
  // idle visitor costs nothing.
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  // Wake: on activity, on the tab becoming visible, and on panel open, do
  // one immediate poll and (re)start the Active interval. Only acts when
  // currently asleep (no interval running) — while already active this is
  // a cheap no-op past the state.pollTimer check, so high-frequency events
  // like pointermove/scroll can call this freely without flooding /poll.
  function wake() {
    markActivity();
    if (state.pollTimer || !state.isOpen || !isPageVisible()) return;
    pollOnce();
    startPolling();
  }

  ["keydown", "pointermove", "scroll", "touchstart", "touchmove"].forEach((type) => {
    document.addEventListener(type, wake, { passive: true, capture: true });
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopPolling();
      return;
    }
    wake();
  });

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
      window.scrollTo({ top: savedScrollY, left: 0, behavior: "instant" });
    }
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Baseline "no keyboard" viewport height, used as a geometry-only
  // fallback for detecting a keyboard when the keyboardOpen flag below
  // hasn't caught up yet (e.g. the very first focus event on a fresh page
  // hasn't fully round-tripped). A one-time load-time snapshot doesn't
  // work here: on iOS, window.innerHeight itself grows once the address
  // bar auto-hides after the page loads, so a value captured before that
  // collapse reads too small — and on exactly the first keyboard open,
  // this fallback could see a viewport that already looks "short" even
  // with no keyboard, making it think a keyboard-shrunk viewport is
  // normal-sized and leaving the decorative top gap in place instead of
  // filling the screen. Track the tallest window.innerHeight seen instead
  // of a fixed snapshot: a keyboard never changes window.innerHeight on
  // iOS (only visualViewport does), so this baseline only ever grows or
  // holds steady as the browser's own chrome settles — it can't be
  // dragged down by a keyboard opening.
  let maxKnownViewportHeight = window.innerHeight;

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
    // Update the baseline before the early-return so it keeps tracking the
    // tallest known height even while closed/desktop (e.g. a chrome-collapse
    // resize that fires between opens).
    if (window.innerHeight > maxKnownViewportHeight) maxKnownViewportHeight = window.innerHeight;

    if (!state.isOpen || !isMobileViewport()) {
      overlay.style.top = "";
      overlay.style.bottom = "";
      overlay.style.height = "";
      return;
    }
    const vv = window.visualViewport;
    if (!vv) return;

    const fillFull = keyboardOpen || vv.height < maxKnownViewportHeight * 0.85;
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

  // The keyboard animates in/out over an unpredictable span (varies by
  // device, keyboard app, and Android vs iOS) — rather than guessing fixed
  // millisecond delays and risking a stale height if the animation runs
  // longer, re-run the fit on every single animation frame for a bounded
  // window. Wasteful cheap work beats a visible gap. 1200ms comfortably
  // outlasts every keyboard show/hide animation observed across devices
  // (typically well under 500ms), including the extra settle time seen on
  // a page's very first keyboard open. Shared by every call site below so
  // the "how long to keep re-measuring" answer lives in exactly one place.
  const VIEWPORT_SYNC_DURATION_MS = 1200;
  let viewportSyncRafId = null;
  function runViewportSyncLoop(durationMs) {
    if (viewportSyncRafId !== null) cancelAnimationFrame(viewportSyncRafId);
    const start = performance.now();
    const tick = (now) => {
      updateMobileViewportSize();
      if (now - start < durationMs) {
        viewportSyncRafId = requestAnimationFrame(tick);
      } else {
        viewportSyncRafId = null;
        scrollMessagesToBottom();
      }
    };
    viewportSyncRafId = requestAnimationFrame(tick);
  }

  inputEl.addEventListener("focus", () => {
    keyboardOpen = true;
    markActivity();
    runViewportSyncLoop(VIEWPORT_SYNC_DURATION_MS);
  });

  inputEl.addEventListener("blur", () => {
    keyboardOpen = false;
    runViewportSyncLoop(VIEWPORT_SYNC_DURATION_MS);
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

    const mobile = isMobileViewport();
    if (mobile) lockBodyScroll(true);
    updateMobileViewportSize();
    // On mobile, start re-measuring from the moment the panel opens rather
    // than waiting for the input's focus event to do it (below). On a
    // fresh page, first open is the only time the panel's entrance
    // animation, the body being pinned position:fixed, AND the keyboard
    // opening all land in the same burst — on iOS WebKit specifically this
    // first-ever keyboard/visualViewport activation can settle slightly
    // later than the focus event itself fires, which left a stale gap on
    // screen until something else (a later resize/scroll) happened to
    // re-trigger updateMobileViewportSize. Second and later opens don't
    // hit this cold-start overlap, which is why the bug only ever showed
    // up on first open. Starting the loop here closes that window; it's
    // cheap to also start it again from focus below (runViewportSyncLoop
    // just restarts its own timer).
    if (mobile) runViewportSyncLoop(VIEWPORT_SYNC_DURATION_MS);
    // Panel open is a Wake trigger: immediate poll, then the Active interval.
    wake();
    // Focus must happen synchronously here, in the same tick as the user's
    // tap/click — iOS Safari only opens the keyboard on focus that traces
    // directly back to a user gesture; a setTimeout or post-animation focus
    // loses that and the keyboard never appears. This reuses the existing
    // focus/blur listeners below, so the Android viewport-resize fix still
    // fires exactly as it does when a visitor taps the input manually.
    inputEl.focus();
    scrollMessagesToBottom();
  }

  function closePanel() {
    state.isOpen = false;
    keyboardOpen = false;
    if (viewportSyncRafId !== null) {
      cancelAnimationFrame(viewportSyncRafId);
      viewportSyncRafId = null;
    }
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
