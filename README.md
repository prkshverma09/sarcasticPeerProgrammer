# DevinCast

Live two-host **sports commentary** for an autonomous coding agent. A simulated coding
session on the left ("The Pitch"), an ESPN-style broadcast booth on the right
("The Broadcast") — commentary written by an LLM, voiced by ElevenLabs, and pushed to
the browser in real time by a Cloudflare Durable Object.

```
Next.js (static export)  ──WebSocket RPC──>  BroadcastAgent (Durable Object)
       │                                            │
   audio playback  <── correlated RPC clip ─────────┤── LLM (OpenRouter / OpenAI)
   retro visualizer                                 └── ElevenLabs TTS (mp3, base64)
```

One Worker serves both the static frontend (`assets` binding) and the agent, so
`npx wrangler dev` runs the whole app.

## Backend — `worker/`

- `BroadcastAgent extends Agent` (Cloudflare `agents` SDK, Durable Object + SQLite state).
- State includes event and transcript history, speaker, playback status, and the unacknowledged clip ID.
- `@callable() processEvent(eventText, eventId?)` — records the exact displayed terminal output, generates a grounded
  reaction with the *next* speaker's persona, synthesizes it with that speaker's ElevenLabs
  `voice_id`, broadcasts `{ type: "clip", clip }` to every connected client, and returns the
  clip (base64 mp3 + transcript + event ID) to the caller. The frontend uses the RPC response
  for event commentary and ignores the duplicate event push.
- `acknowledgeClip(clipId)` releases the playback gate only after that audio ends.
  Concurrent generation and new events during pending playback are rejected.
- `setPlaybackStatus("active" | "idle" | "stopped")` controls broadcast lifecycle.
  Connecting alone does not start a broadcast; disconnecting the last viewer stops it.
- `scheduleEvery(30, "checkDeadAir")` generates banter only after 25s of explicitly idle
  playback, with no pending clip and a connected viewer. It refers to the last visible
  event and does not invent new activity. Provider calls time out after 30s each.
- Speaker personas and voice IDs live in `worker/personas.ts`.

## Frontend — `app/`

- Dark split-screen UI, Next.js App Router with `output: "export"`.
- **The Pitch**: a simulated cloud coding agent session (`app/session.ts`) — plan steps,
  shell commands with streamed stdout/stderr, diffs and git output.
- Each GO LIVE/restart gets a new UUID-named `useAgent` instance, empty local transcript,
  and isolated Durable Object state. Tabs and previous runs cannot mix broadcasts.
- The sequence is `render all step output → paint → processEvent(exact output, eventId)
  → play matching clip → audio ended → acknowledge → next step`. Slow providers or long
  clips hold the current step; errors stop the sequence with a visible restart control.
- **The Broadcast** shows a transcript line when its audio actually starts. Step labels
  and highlighting identify its source terminal event. There is no audio backlog.
- The eight-step demo finishes once, then enables idle banter. STOP aborts timers and
  audio, and late provider responses are discarded. RESTART DEMO creates a fresh run.
- Browsers block autoplay until a gesture, so the show starts with the **GO LIVE** button.

## Setup

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your keys
npm run dev                      # next build + wrangler dev on :8787
```

| Variable             | Required | Notes                                                       |
| -------------------- | -------- | ----------------------------------------------------------- |
| `ELEVENLABS_API_KEY` | yes      | Needs `text_to_speech` permission                            |
| `OPENROUTER_API_KEY` | one of   | Preferred when set                                           |
| `OPENAI_API_KEY`     | one of   | Fallback                                                     |
| `LLM_MODEL`          | no       | Defaults to `gpt-4o-mini` / `openai/gpt-4o-mini`             |
| `ELEVENLABS_MODEL_ID`| no       | Defaults to `eleven_flash_v2_5`                              |

On a free ElevenLabs plan, library voices return `402 paid_plan_required`; the defaults in
`worker/personas.ts` (Adam + George) work on the free tier.

## Scripts

```bash
node scripts/smoke.mjs                # push one event over RPC, write the mp3 to /tmp
npm test                             # deterministic synchronization and prompt regressions (Node 24)
node scripts/sync-smoke.mjs           # live providers: isolation, correlation, playback gate and idle banter
npm run typecheck
npm run deploy                        # wrangler deploy (set secrets with `wrangler secret put`)
```
