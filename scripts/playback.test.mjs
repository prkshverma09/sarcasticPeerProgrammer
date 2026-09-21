import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { runSession } from "../app/playback.ts";
import { SESSION_STEPS } from "../app/session.ts";
import { commentOnEvent, deadAirBanter } from "../worker/llm.ts";
import { PERSONAS } from "../worker/personas.ts";

const steps = [
  { title: "Build", lines: [
    { kind: "cmd", text: "npm run build", delay: 0 },
    { kind: "err", text: "Found 147 errors. Exit code 2.", delay: 0 }
  ] },
  { title: "Vim", lines: [{ kind: "ok", text: "Successfully rebased", delay: 0 }] }
];

function clip(eventId) {
  return { id: crypto.randomUUID(), kind: "event", eventId };
}

function harness(overrides = {}) {
  const controller = new AbortController();
  const trace = [];
  return {
    controller,
    trace,
    options: {
      steps,
      signal: controller.signal,
      onStep: (_, index) => trace.push(`step:${index}`),
      onLine: (line) => trace.push(line.text),
      afterRender: async () => trace.push("paint"),
      generate: async (_, eventId) => clip(eventId),
      play: async () => trace.push("play"),
      ...overrides
    }
  };
}

test("requests only painted output and holds the step through slow generation and audio", async () => {
  const generating = Promise.withResolvers();
  const generated = Promise.withResolvers();
  const playing = Promise.withResolvers();
  const ended = Promise.withResolvers();
  let first = true;
  const h = harness({
    generate: async (text, id) => {
      if (first) {
        assert.equal(text, "$ npm run build\nFound 147 errors. Exit code 2.");
        assert.deepEqual(h.trace, ["step:0", "npm run build", "Found 147 errors. Exit code 2.", "paint"]);
        generating.resolve();
        await generated.promise;
      }
      return clip(id);
    },
    play: async () => {
      if (first) {
        playing.resolve();
        await ended.promise;
        first = false;
      }
    }
  });
  const running = runSession(h.options);
  await generating.promise;
  await nextTurn();
  assert.ok(!h.trace.includes("step:1"));
  generated.resolve();
  await playing.promise;
  await nextTurn();
  assert.ok(!h.trace.includes("step:1"));
  ended.resolve();
  await running;
  assert.ok(h.trace.includes("step:1"));
});

test("stop during terminal streaming cancels remaining output and generation", async () => {
  const h = harness({
    onLine: () => h.controller.abort(),
    generate: async () => assert.fail("must not request commentary"),
    play: async () => assert.fail("must not play commentary")
  });
  await assert.rejects(runSession(h.options), { name: "AbortError" });
  assert.deepEqual(h.trace, ["step:0"]);
});

test("a late provider response after stop cannot play or advance the demo", async () => {
  const entered = Promise.withResolvers();
  const reply = Promise.withResolvers();
  const h = harness({
    generate: async (_, id) => {
      entered.resolve();
      await reply.promise;
      return clip(id);
    },
    play: async () => assert.fail("cancelled clip must not play")
  });
  const running = runSession(h.options);
  await entered.promise;
  h.controller.abort();
  reply.resolve();
  await assert.rejects(running, { name: "AbortError" });
  assert.ok(!h.trace.includes("step:1"));
});

test("a mismatched event clip is rejected before playback", async () => {
  const h = harness({
    generate: async () => clip("different-session-event"),
    play: async () => assert.fail("stale clip must not play")
  });
  await assert.rejects(runSession(h.options), /does not match/);
  assert.ok(!h.trace.includes("step:1"));
});

test("a playback failure stops progression instead of silently skipping the clip", async () => {
  const h = harness({ play: async () => { throw new Error("Audio decode failed"); } });
  await assert.rejects(runSession(h.options), /Audio decode failed/);
  assert.ok(!h.trace.includes("step:1"));
});

test("all eight demo steps finish once, with unique IDs and verbatim terminal context", async () => {
  const ids = new Set();
  let count = 0;
  const h = harness({
    steps: SESSION_STEPS.map((step) => ({
      ...step, lines: step.lines.map((line) => ({ ...line, delay: 0 }))
    })),
    generate: async (text, id) => {
      assert.equal(text, SESSION_STEPS[count].lines
        .map((line) => line.kind === "cmd" ? `$ ${line.text}` : line.text).join("\n"));
      assert.ok(!ids.has(id));
      ids.add(id);
      count++;
      return clip(id);
    }
  });
  await runSession(h.options);
  assert.equal(count, 8);
  assert.equal(h.trace.filter((entry) => entry === "play").length, 8);
});

test("event prompts use current evidence; idle prompts explicitly deny new activity", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: "The build reports 147 errors." } }] });
  });
  const output = "$ npm run build\nFound 147 errors. Exit code 2.";
  await commentOnEvent({ OPENAI_API_KEY: "test-only" }, PERSONAS.A, output);
  assert.ok(requests[0].messages[1].content.includes(output));
  assert.ok(!requests[0].messages[1].content.includes("Recent broadcast"));
  assert.match(requests[0].messages[0].content, /Describe the latest visible outcome accurately/);
  await deadAirBanter({ OPENAI_API_KEY: "test-only" }, PERSONAS.B, output, ["The build failed."]);
  assert.ok(requests[1].messages[1].content.includes(output));
  assert.match(requests[1].messages[1].content, /there is no new activity/);
});
