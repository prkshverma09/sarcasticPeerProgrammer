// Origin of the deployed Cloudflare Worker that bridges to OpenAI Realtime.
// For local development run `npm run dev` in the repo root and keep localhost.
const WORKER_ORIGIN = "http://localhost:8787";

let sessionId = null;
let pushSocket = null;

// The service worker is evicted after ~30s idle, so anything kept in a module
// global is lost while the user is still listening. Session storage survives it.
async function getLive() {
  const stored = await chrome.storage.session.get(["live", "liveTabId"]);
  return { live: stored.live === true, liveTabId: stored.liveTabId ?? null };
}

async function setLive(live, liveTabId) {
  await chrome.storage.session.set({ live, liveTabId });
}

async function getSessionId() {
  if (sessionId) return sessionId;
  const stored = await chrome.storage.local.get("sessionId");
  sessionId = stored.sessionId || crypto.randomUUID();
  if (!stored.sessionId) await chrome.storage.local.set({ sessionId });
  return sessionId;
}

async function call(method, args = []) {
  const id = await getSessionId();
  const res = await fetch(`${WORKER_ORIGIN}/sessions/${id}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `worker returned ${res.status}`);
  return data.result;
}

// Broadcast pushes (idle dead-air commentary) arrive on the agent WebSocket.
async function openPushSocket() {
  if (pushSocket && pushSocket.readyState <= WebSocket.OPEN) return;
  const id = await getSessionId();
  const ws = new WebSocket(`${WORKER_ORIGIN.replace(/^http/, "ws")}/agents/broadcast-agent/${id}`);
  ws.onmessage = (event) => {
    void (async () => {
      try {
        const data = JSON.parse(event.data);
        if (data.type !== "clip" && data.type !== "broadcast-error") return;
        const { liveTabId } = await getLive();
        if (liveTabId !== null) {
          chrome.tabs.sendMessage(liveTabId, { kind: "broadcast", data }).catch(() => {});
        }
      } catch {}
    })();
  };
  ws.onclose = () => {
    pushSocket = null;
    void getLive().then(({ live }) => {
      if (live) setTimeout(() => openPushSocket().catch(() => {}), 3000);
    });
  };
  ws.onerror = () => {};
  pushSocket = ws;
}

function closePushSocket() {
  const ws = pushSocket;
  pushSocket = null;
  try { ws?.close(); } catch {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const state = await getLive();
    const tabId = sender.tab?.id ?? state.liveTabId;
    switch (message.kind) {
      case "start": {
        await setLive(true, tabId);
        await openPushSocket();
        await call("setPlaybackStatus", ["idle"]);
        return { ok: true };
      }
      case "stop": {
        await setLive(false, null);
        closePushSocket();
        await call("setPlaybackStatus", ["stopped"]).catch(() => {});
        return { ok: true };
      }
      case "action": {
        if (!state.live) throw new Error("Commentary is not started");
        if (tabId !== state.liveTabId) await setLive(true, tabId);
        await openPushSocket();
        const clip = await call("processEvent", [message.text]);
        return { clip };
      }
      case "ack": {
        await call("acknowledgeClip", [message.clipId]).catch(() => {});
        return { ok: true };
      }
      case "idle": {
        await call("setPlaybackStatus", [message.status]).catch(() => {});
        return { ok: true };
      }
      default:
        throw new Error(`Unknown message kind: ${message.kind}`);
    }
  })().then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});
