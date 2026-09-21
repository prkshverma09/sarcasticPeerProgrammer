// Connects and stays idle so the 30s scheduleEvery() dead-air check fires.
import { AgentClient } from "agents/client";

const client = new AgentClient({
  agent: "BroadcastAgent",
  name: "dead-air-test",
  host: process.argv[2] ?? "localhost:8787"
});

client.onmessage = (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.type === "clip") {
      console.log(
        `[${new Date().toISOString()}] ${data.clip.kind} — ${data.clip.speakerName}: ${data.clip.text} (${data.clip.audio.length} b64 chars)`
      );
    }
  } catch {}
};

console.log("connected, idling 80s waiting for dead-air banter...");
setTimeout(() => process.exit(0), 80_000);
