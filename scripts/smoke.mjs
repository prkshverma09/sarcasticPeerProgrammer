// Smoke test: posts a user action to the worker's HTTP bridge (the same one the
// extension uses) and writes the returned OpenAI Realtime audio to /tmp.
// Usage: node scripts/smoke.mjs [origin] ["action description"]
import { writeFileSync } from "node:fs";

const origin = process.argv[2] ?? "http://localhost:8787";
const action = process.argv[3] ??
  'The user clicked "Force push", a button, on the page "Pull request #42".';
const session = `smoke-${crypto.randomUUID()}`;

async function call(method, args = []) {
  const res = await fetch(`${origin}/sessions/${session}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, args })
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error ?? `worker returned ${res.status}`);
  return data.result;
}

console.log(`sending to ${origin}: ${action}`);
const started = Date.now();
const clip = await call("processEvent", [action]);
const bytes = Buffer.from(clip.audio, "base64");
const out = `/tmp/spp-${clip.id.slice(0, 8)}.wav`;
writeFileSync(out, bytes);
await call("acknowledgeClip", [clip.id]);

console.log(`commentator : ${clip.speakerName}`);
console.log(`line        : ${clip.text}`);
console.log(`audio       : ${bytes.length} bytes -> ${out}`);
console.log(`latency     : ${Date.now() - started} ms`);
