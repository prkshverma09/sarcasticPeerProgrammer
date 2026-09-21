// Smoke test: connects to the BroadcastAgent over WebSocket RPC, pushes a coding
// event, and writes the returned ElevenLabs audio to /tmp so it can be played back.
// Usage: node scripts/smoke.mjs [host] ["event text"]
import { writeFileSync } from "node:fs";
import { AgentClient } from "agents/client";

const host = process.argv[2] ?? "localhost:8787";
const eventText = process.argv[3] ?? "Terminal: npm run build failed with 147 TypeScript errors";

const client = new AgentClient({
  agent: "BroadcastAgent",
  name: "smoke-test",
  host
});

client.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.type === "clip") {
      console.log(`[broadcast push] ${data.clip.speakerName} (${data.clip.kind}): ${data.clip.text}`);
    }
  } catch {}
};

await new Promise((resolve, reject) => {
  client.onopen = resolve;
  client.onerror = reject;
  setTimeout(() => reject(new Error("timed out connecting")), 15_000);
});

console.log(`connected to ${host}, sending: ${eventText}`);
const started = Date.now();
const clip = await client.call("processEvent", [eventText]);
const bytes = Buffer.from(clip.audio, "base64");
const out = `/tmp/devincast-${clip.speaker}-${clip.id.slice(0, 8)}.mp3`;
writeFileSync(out, bytes);

console.log(`speaker : ${clip.speakerName} (${clip.speaker})`);
console.log(`line    : ${clip.text}`);
console.log(`audio   : ${bytes.length} bytes -> ${out}`);
console.log(`latency : ${Date.now() - started} ms`);
client.close();
process.exit(0);
