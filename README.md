# Sarcastic Peer Programmer

A Chrome extension with one opinionated commentator. She watches what you do on the
current page — clicks, typed input, dropdowns, form submits, navigation — and says
something dry about it out loud. Voice comes from the **OpenAI Realtime API**, spoken
through a Cloudflare Worker so your API key never reaches the browser.

```
Chrome extension                 Cloudflare Worker
  content.js  ──user action──>   BroadcastAgent (Durable Object)
  (voice pill)                        │
     ▲                                └── WebSocket ──> OpenAI Realtime (gpt-realtime)
     └────── spoken WAV clip ─────────────────────────────  text + audio
```

## Worker — `worker/`

- `BroadcastAgent extends Agent` (Cloudflare `agents` SDK, Durable Object + SQLite state).
- `RealtimeCommentator` (`worker/realtime.ts`) holds **one persistent Realtime WebSocket**
  per session. Each action is sent as a `conversation.item.create` + `response.create`;
  audio deltas are concatenated and wrapped in a WAV container (24 kHz mono PCM16).
  Conversation history lives in the session, so she does not repeat her own jokes.
- The commentator's persona and prompts live in `worker/commentator.ts`. There is exactly
  one commentator: **Vera Merge**.
- `@callable() processEvent(actionText, eventId?)` returns the clip (transcript + base64 WAV)
  and pushes it to connected clients. `acknowledgeClip(clipId)` releases the gate only once
  that audio has finished, so actions cannot overlap.
- After 25s of explicitly idle playback, `checkDeadAir` produces one grounded idle remark
  about the last visible action.
- Besides the agent WebSocket, the Worker exposes a plain JSON bridge the extension uses:
  `POST /sessions/:id/call` with `{ "method": "processEvent", "args": ["..."] }`.

## Extension — `extension/`

- Manifest V3. `content.js` runs on every page; `background.js` is the only thing that
  talks to the Worker.
- **Voice-only UI**: a single floating pill in the bottom-right. Click to start or stop.
  It shows `Listening` / `Thinking` / `Speaking` and animates while she talks. No transcript.
- **Typing is reported only when you are done with a field** — on blur, on Enter, or after
  1.5s of no keystrokes — never per character. Password-ish fields report only a character
  count, never their contents.
- Only the newest action is voiced; a backlog of stale commentary is dropped.

## Running it locally

1. `npm install`
2. `cp .dev.vars.example .dev.vars` and set `OPENAI_API_KEY` (an OpenAI key with Realtime access).
3. `npm run dev` — the Worker listens on `http://localhost:8787`. Requires Node 22+.
4. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select
   the `extension/` directory.
5. Open any normal page (not `chrome://`), click the pill in the bottom-right, and use the page.
   Chrome may require one click on the page before it allows audio.

To point the extension at a deployed Worker, change `WORKER_ORIGIN` at the top of
`extension/background.js`.

### Verifying the Worker on its own

```
node scripts/smoke.mjs                       # uses http://localhost:8787
node scripts/smoke.mjs http://localhost:8787 'The user clicked "Delete account", a button.'
```

It prints the spoken line and writes the WAV to `/tmp` so you can play it.

## Deploying

```
npx wrangler secret put OPENAI_API_KEY
npm run deploy
```

Optional vars: `OPENAI_REALTIME_MODEL` (default `gpt-realtime`) and `OPENAI_REALTIME_VOICE`
(default `marin`).
