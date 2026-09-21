import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { AgentClient } from "agents/client";

const host = process.argv[2] ?? "localhost:8787";
const clients = [];

async function connect() {
  const client = new AgentClient({
    agent: "BroadcastAgent", name: `sync-test-${crypto.randomUUID()}`, host
  });
  clients.push(client);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Connection timed out")), 15_000);
    client.onopen = () => { clearTimeout(timeout); resolve(); };
    client.onerror = () => { clearTimeout(timeout); reject(new Error("Connection failed")); };
  });
  const clips = [];
  client.addEventListener("message", (message) => {
    const data = JSON.parse(message.data);
    if (data.type === "clip") clips.push(data.clip);
  });
  return { client, clips };
}

try {
  const a = await connect();
  const b = await connect();
  const id = crypto.randomUUID();
  const output = "$ npm run build\nFound 147 TypeScript errors. Exit code 2.";
  const generating = a.client.call("processEvent", [output, id]);
  await assert.rejects(a.client.call("processEvent", ["Must not overtake current output", crypto.randomUUID()]));
  const first = await generating;
  assert.equal(first.eventId, id);
  assert.equal(first.eventText, output);
  assert.equal(first.speaker, "A");
  assert.ok(Buffer.from(first.audio, "base64").length > 1000);
  assert.deepEqual(await b.client.call("getTranscript"), []);
  assert.equal(b.clips.length, 0);
  await a.client.call("acknowledgeClip", ["wrong-clip"]);
  await assert.rejects(a.client.call("processEvent", ["Must wait for the right acknowledgment"]));
  console.log(`Build: ${first.text}`);

  const second = await b.client.call("processEvent", [
    "$ git rebase origin/main\nvim opened COMMIT_EDITMSG\n:wq\nSuccessfully rebased and updated refs/heads/demo",
    crypto.randomUUID()
  ]);
  assert.equal(second.speaker, "A");
  assert.notEqual(second.eventId, first.eventId);
  assert.equal((await a.client.call("getTranscript")).length, 1);
  console.log(`Vim: ${second.text}`);

  await a.client.call("setPlaybackStatus", ["idle"]);
  await wait(35_000);
  assert.equal(a.clips.length, 1, "idle banter must wait for playback acknowledgment");
  assert.equal(b.clips.length, 1, "active sessions must not generate idle banter");
  await a.client.call("acknowledgeClip", [first.id]);
  const deadline = Date.now() + 65_000;
  while (a.clips.length === 1 && Date.now() < deadline) await wait(250);
  const idle = a.clips[1];
  assert.ok(idle, "scheduled idle banter must arrive");
  assert.equal(idle.kind, "dead-air");
  assert.equal(idle.eventId, first.eventId);
  assert.equal(idle.eventText, output);
  assert.equal(idle.speaker, "B");
  console.log(`Idle: ${idle.text}`);
  console.log("PASS: isolation, correlation, concurrency, acknowledgments and scheduled idle banter");
} finally {
  for (const client of clients) {
    try { await client.call("setPlaybackStatus", ["stopped"]); } catch {}
    client.close();
  }
}
