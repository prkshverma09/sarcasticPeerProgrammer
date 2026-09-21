// Watches user actions on the page, sends them to the worker for commentary,
// and speaks the reply. The UI is a single voice pill: no transcript.

const TYPING_SETTLE_MS = 1500;
const IDLE_AFTER_MS = 4000;
const MAX_TEXT = 120;

let live = false;
let speaking = false;
const queue = [];
let idleTimer = null;

// ---------------------------------------------------------------- describing

// A form control's own text is its options or nothing, so ask its <label> first.
function controlLabel(el) {
  if (el.id) {
    const tag = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    const text = tag?.innerText?.trim().replace(/\s+/g, " ");
    if (text) return text;
  }
  const wrapper = el.closest?.("label")?.innerText?.trim().replace(/\s+/g, " ");
  return wrapper || "";
}

function label(el) {
  if (!el || el === document.body) return "the page";
  const aria = el.getAttribute?.("aria-label")?.trim();
  if (aria) return `"${aria}"`;
  if (["SELECT", "INPUT", "TEXTAREA"].includes(el.tagName)) {
    const named = controlLabel(el);
    if (named) return `the "${named}" field`;
  }
  const text = el.innerText?.trim().replace(/\s+/g, " ");
  if (text && text.length <= 60) return `"${text}"`;
  const placeholder = el.getAttribute?.("placeholder")?.trim();
  if (placeholder) return `the "${placeholder}" field`;
  const name = el.getAttribute?.("name")?.trim();
  if (name) return `the "${name}" field`;
  const title = el.getAttribute?.("title")?.trim();
  if (title) return `"${title}"`;
  const alt = el.querySelector?.("img[alt]")?.getAttribute("alt");
  if (alt) return `the "${alt}" image`;
  const role = el.getAttribute?.("role");
  if (role) return `a ${role}`;
  return `a <${el.tagName.toLowerCase()}>`;
}

function kindOf(el) {
  const tag = el.tagName?.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return "link";
  if (tag === "input") return el.type === "submit" ? "button" : `${el.type || "text"} input`;
  if (tag === "select") return "dropdown";
  if (tag === "textarea") return "text area";
  if (el.getAttribute?.("role") === "button") return "button";
  return tag || "element";
}

function truncate(value) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
}

function isSecret(el) {
  if (el.type?.toLowerCase() === "password") return true;
  const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute?.("autocomplete") || ""}`.toLowerCase();
  return /pass|secret|token|otp|cvv|card|ssn/.test(hint);
}

// ------------------------------------------------------------- voice-only UI

let ui = null;

function overlay() {
  if (ui) return ui;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;z-index:2147483647;right:16px;bottom:16px;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      .pill {
        display: flex; align-items: center; gap: 9px; cursor: pointer;
        padding: 9px 14px; border-radius: 999px; border: 1px solid #2c3040;
        background: #12141a; color: #8b90a5; box-shadow: 0 6px 20px rgba(0,0,0,.4);
        font: 12px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: 1px;
        text-transform: uppercase; user-select: none;
      }
      .pill.live { color: #ffb454; border-color: #4a3a1e; }
      .pill.error { color: #ff6b6b; border-color: #4a1e1e; }
      .wave { display: flex; align-items: center; gap: 2px; height: 14px; }
      .wave i {
        width: 2px; height: 3px; border-radius: 1px; background: currentColor;
        display: block;
      }
      .pill.live .wave i { animation: pulse 1s ease-in-out infinite; }
      .pill.speaking .wave i { animation-duration: .45s; }
      .wave i:nth-child(2) { animation-delay: .12s; }
      .wave i:nth-child(3) { animation-delay: .24s; }
      .wave i:nth-child(4) { animation-delay: .36s; }
      @keyframes pulse { 0%,100% { height: 3px; } 50% { height: 14px; } }
    </style>
    <div class="pill" role="button" tabindex="0" title="Sarcastic peer programmer">
      <span class="wave"><i></i><i></i><i></i><i></i></span>
      <span class="state">Listen in</span>
    </div>`;
  document.documentElement.appendChild(host);
  const pill = root.querySelector(".pill");
  ui = { pill, state: root.querySelector(".state") };
  pill.addEventListener("click", () => (live ? stop() : start()));
  return ui;
}

function setState(text, className) {
  const { pill, state } = overlay();
  state.textContent = text;
  pill.classList.toggle("live", live);
  pill.classList.toggle("speaking", className === "speaking");
  pill.classList.toggle("error", className === "error");
}

// ------------------------------------------------------------------ playback

async function playClip(clip) {
  const bytes = Uint8Array.from(atob(clip.audio), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: clip.mimeType || "audio/wav" }));
  const audio = new Audio(url);
  setState("Speaking", "speaking");
  try {
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onerror = () => reject(new Error("audio playback failed"));
      audio.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drain() {
  if (speaking) return;
  speaking = true;
  let failed = false;
  try {
    while (live && queue.length) {
      const action = queue.shift();
      setState("Thinking");
      try {
        const reply = await chrome.runtime.sendMessage({ kind: "action", text: action });
        if (reply?.error) throw new Error(reply.error);
        await playClip(reply.clip);
        await chrome.runtime.sendMessage({ kind: "ack", clipId: reply.clip.id });
        failed = false;
      } catch (error) {
        failed = true;
        console.warn("[sarcastic peer programmer]", error.message);
      }
    }
  } finally {
    speaking = false;
    // Stay on Error until something works again: a silent pill that claims to be
    // listening is worse than no pill at all.
    if (live) failed ? setState("Error", "error") : setState("Listening");
    scheduleIdle();
  }
}

// Re-sending a status the worker already has bumps its revision and cancels the
// line it is mid-way through generating, so only send transitions.
let playbackStatus = null;
function setPlaybackStatus(status) {
  if (status === playbackStatus) return;
  playbackStatus = status;
  void chrome.runtime.sendMessage({ kind: "idle", status });
}

function report(action) {
  if (!live) return;
  clearTimeout(idleTimer);
  // Only the newest action matters; never build a backlog of stale commentary.
  queue.length = 0;
  queue.push(action);
  setPlaybackStatus("active");
  void drain();
}

function scheduleIdle() {
  clearTimeout(idleTimer);
  if (!live) return;
  idleTimer = setTimeout(() => setPlaybackStatus("idle"), IDLE_AFTER_MS);
}

// ------------------------------------------------------------------ watching

const typing = new Map(); // element -> { timer, start }

function isTextField(el) {
  return el.isContentEditable ||
    (["INPUT", "TEXTAREA"].includes(el.tagName) &&
      !["checkbox", "radio", "submit", "button"].includes(el.type));
}

function flushTyping(el, reason) {
  const entry = typing.get(el);
  if (!entry) return;
  clearTimeout(entry.timer);
  typing.delete(el);
  const value = el.isContentEditable ? el.innerText : el.value;
  if (value === entry.start) return;
  const what = isSecret(el)
    ? `${value?.length || 0} characters of something secret`
    : `"${truncate(value)}"`;
  report(`The user finished typing ${what} into ${label(el)} (${reason}).`);
}

function onInput(event) {
  const el = event.target;
  if (!el?.tagName || !isTextField(el)) return;
  const entry = typing.get(el) ?? { start: el.isContentEditable ? el.innerText : el.value };
  clearTimeout(entry.timer);
  // Comment only once the field is done: a pause long enough to count as finished.
  entry.timer = setTimeout(() => flushTyping(el, "paused"), TYPING_SETTLE_MS);
  typing.set(el, entry);
}

function onBlur(event) {
  flushTyping(event.target, "moved on");
}

function onKeyDown(event) {
  if (event.key === "Enter" && typing.has(event.target)) {
    flushTyping(event.target, "pressed enter");
  }
}

function onClick(event) {
  const el = event.target.closest?.("a, button, input, select, textarea, [role], label") || event.target;
  if (!el?.tagName) return;
  // A click into a text field is the start of typing, not an action worth voicing.
  if (typing.has(el) || isTextField(el)) return;
  // Selects and toggles fire `change` too; that event describes the action better.
  if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") return;
  const disabled = el.disabled ? ", which is disabled and did nothing" : "";
  report(`The user clicked ${label(el)}, a ${kindOf(el)}${disabled}, on the page "${document.title}".`);
}

function onChange(event) {
  const el = event.target;
  if (el.tagName === "SELECT") {
    report(`The user chose "${truncate(el.selectedOptions[0]?.text || el.value)}" in ${label(el)}, a dropdown.`);
  } else if (el.type === "checkbox" || el.type === "radio") {
    report(`The user ${el.checked ? "checked" : "unchecked"} ${label(el)}.`);
  }
}

function onSubmit() {
  report(`The user submitted a form on the page "${document.title}".`);
}

let lastUrl = location.href;
function watchNavigation() {
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    report(`The user navigated to the page "${document.title}" at ${location.hostname}${location.pathname}.`);
  }, 1000);
}

const LISTENERS = [
  ["click", onClick, true],
  ["input", onInput, true],
  ["focusout", onBlur, true],
  ["keydown", onKeyDown, true],
  ["change", onChange, true],
  ["submit", onSubmit, true]
];

async function start() {
  setState("Connecting");
  const reply = await chrome.runtime.sendMessage({ kind: "start" });
  if (reply?.error) {
    setState("Offline", "error");
    console.warn("[sarcastic peer programmer]", reply.error);
    return;
  }
  live = true;
  playbackStatus = "idle";
  for (const [type, handler, capture] of LISTENERS) {
    document.addEventListener(type, handler, capture);
  }
  setState("Listening");
  report(`The user opened commentary on the page "${document.title}" at ${location.hostname}.`);
}

function stop() {
  live = false;
  playbackStatus = null;
  queue.length = 0;
  clearTimeout(idleTimer);
  for (const [type, handler, capture] of LISTENERS) {
    document.removeEventListener(type, handler, capture);
  }
  setState("Listen in");
  void chrome.runtime.sendMessage({ kind: "stop" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.kind !== "broadcast" || !live) return;
  const { data } = message;
  if (data.type === "clip" && data.clip.kind === "dead-air" && !speaking) {
    void (async () => {
      await playClip(data.clip).catch(() => {});
      await chrome.runtime.sendMessage({ kind: "ack", clipId: data.clip.id });
    })();
  }
});

overlay();
setState("Listen in");
watchNavigation();
