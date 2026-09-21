"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import type { BroadcastAgent, BroadcastClip, BroadcastState, Segment } from "../worker";
import { SESSION, SESSION_STEPS, type LineKind } from "./session";
import { runSession, waitFor } from "./playback";
import { playAudio } from "./audio";

const BAR_COUNT = 48;

type TerminalLine = { id: string; eventId: string; kind: LineKind; text: string; at: number };
type Run = { id: string; ctx: AudioContext; analyser: AnalyserNode };
type Phase = "ready" | "connecting" | "terminal" | "generating" | "playing" | "idle" | "stopped" | "error";
type Commentary = Segment & { step: number; title: string };

const STATUS: Record<Phase, string> = {
  ready: "Ready to start",
  connecting: "Connecting to the booth",
  terminal: "Agent working",
  generating: "Preparing commentary for this step",
  playing: "Commentating on this step",
  idle: "Session complete · waiting for new activity",
  stopped: "Broadcast stopped",
  error: "Broadcast paused · restart to retry"
};

const PREFIX: Partial<Record<LineKind, string>> = {
  cmd: "$",
  plan: "◆",
  thought: "·",
  ok: "✓",
  warn: "!",
  err: "✕",
  file: "✎"
};

const clock = (at: number) =>
  new Date(at).toLocaleTimeString("en-US", { hour12: false });

export default function Page() {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const starting = useRef(false);
  const goLive = async () => {
    if (starting.current) return;
    starting.current = true;
    setError(null);
    let ctx: AudioContext | undefined;
    try {
      ctx = new AudioContext();
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(ctx.destination);
      setRun({ id: `demo-${crypto.randomUUID()}`, ctx, analyser });
    } catch (cause) {
      void ctx?.close();
      setError(`Could not start audio: ${String(cause)}`);
    } finally {
      starting.current = false;
    }
  };

  useEffect(() => () => {
    if (run) {
      run.analyser.disconnect();
      void run.ctx.close();
    }
  }, [run]);

  return <Studio key={run?.id ?? "ready"} run={run} onStart={goLive} startError={error} />;
}

function Studio({ run, onStart, startError }: {
  run: Run | null;
  onStart: () => Promise<void>;
  startError: string | null;
}) {
  const [phase, setPhase] = useState<Phase>(run ? "connecting" : "ready");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [segments, setSegments] = useState<Commentary[]>([]);
  const [current, setCurrent] = useState<{ eventId: string; index: number; title: string } | null>(null);
  const [nowPlaying, setNowPlaying] = useState<Segment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const phaseRef = useRef(phase);
  const currentRef = useRef(current);
  const controller = useRef<AbortController | null>(null);
  const played = useRef(new Set<string>());
  const terminalEnd = useRef<HTMLDivElement | null>(null);
  const broadcastEnd = useRef<HTMLDivElement | null>(null);

  const changePhase = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const playClip = useCallback(async (clip: BroadcastClip, signal: AbortSignal) => {
    const event = currentRef.current;
    if (!run || !event || event.eventId !== clip.eventId || played.current.has(clip.id)) {
      throw new Error("Received stale or duplicate commentary");
    }
    signal.throwIfAborted();
    played.current.add(clip.id);
    await playAudio(clip, run.ctx, run.analyser, signal, () => {
      changePhase("playing");
      setNowPlaying(clip);
      setSegments((prev) => [...prev, {
        ...clip, step: event.index + 1, title: event.title, at: Date.now()
      }]);
    });
    signal.throwIfAborted();
    setNowPlaying(null);
  }, [run, changePhase]);

  const fail = (cause: unknown) => {
    if (controller.current?.signal.aborted) return;
    controller.current?.abort();
    setError(cause instanceof Error ? cause.message : String(cause));
    setNowPlaying(null);
    changePhase("error");
    void agent.stub.setPlaybackStatus("stopped").catch(() => {});
  };

  const agent = useAgent<BroadcastAgent, BroadcastState>({
    agent: "BroadcastAgent",
    name: run?.id ?? "standby",
    startClosed: !run,
    defaultCallTimeout: 70_000,
    onMessage: (message) => {
      if (!run || controller.current?.signal.aborted) return;
      let data: { type?: string; clip?: BroadcastClip; message?: string };
      try {
        data = JSON.parse(message.data as string) as typeof data;
      } catch {
        return;
      }
      if (data.type === "broadcast-error") {
        fail(new Error(data.message ?? "Commentary generation failed"));
        return;
      }
      const clip = data.clip;
      if (
        data.type !== "clip" || clip?.kind !== "dead-air" ||
        phaseRef.current !== "idle" || clip.eventId !== currentRef.current?.eventId ||
        !controller.current || played.current.has(clip.id)
      ) return;
      const signal = controller.current.signal;
      changePhase("generating");
      void (async () => {
        await playClip(clip, signal);
        await agent.stub.acknowledgeClip(clip.id);
        signal.throwIfAborted();
        changePhase("idle");
      })().catch(fail);
    },
    onConnectionError: (cause) => fail(cause)
  });

  useEffect(() => {
    if (!run) return;
    const abort = new AbortController();
    controller.current = abort;
    const { signal } = abort;
    void (async () => {
      const deadline = Date.now() + 15_000;
      while (agent.readyState !== WebSocket.OPEN) {
        if (Date.now() > deadline) throw new Error("Timed out connecting to the broadcast");
        await waitFor(100, signal);
      }
      signal.throwIfAborted();
      await agent.stub.setPlaybackStatus("active");
      signal.throwIfAborted();
      await runSession({
        steps: SESSION_STEPS,
        signal,
        onStep: (step, index, eventId) => {
          const event = { eventId, index, title: step.title };
          currentRef.current = event;
          setCurrent(event);
          changePhase("terminal");
        },
        onLine: (line, eventId) => setLines((prev) => [
          ...prev, { ...line, eventId, id: crypto.randomUUID(), at: Date.now() }
        ]),
        afterRender: () => new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        ),
        generate: async (text, eventId) => {
          changePhase("generating");
          return agent.stub.processEvent(text, eventId);
        },
        play: async (clip) => {
          await playClip(clip, signal);
          await agent.stub.acknowledgeClip(clip.id);
          await waitFor(700, signal);
        }
      });
      signal.throwIfAborted();
      await agent.stub.setPlaybackStatus("idle");
      signal.throwIfAborted();
      changePhase("idle");
    })().catch((cause: unknown) => {
      if (signal.aborted) return;
      abort.abort();
      setError(cause instanceof Error ? cause.message : String(cause));
      setNowPlaying(null);
      changePhase("error");
      void agent.stub.setPlaybackStatus("stopped").catch(() => {});
    });
    return () => {
      abort.abort();
      void agent.stub.setPlaybackStatus("stopped").catch(() => {});
    };
  }, [run, agent, changePhase, playClip]);

  useEffect(() => {
    if (!run) return;
    let frame = 0;
    const data = new Uint8Array(run.analyser.frequencyBinCount);
    const tick = () => {
      run.analyser.getByteFrequencyData(data);
      const step = Math.floor(data.length / BAR_COUNT) || 1;
      setLevels(Array.from({ length: BAR_COUNT }, (_, i) => {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += data[i * step + j] ?? 0;
        return Math.round((sum / step / 255) * 100);
      }));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run]);

  useEffect(() => {
    terminalEnd.current?.scrollIntoView({ block: "nearest" });
  }, [lines]);

  useEffect(() => {
    broadcastEnd.current?.scrollIntoView({ block: "nearest" });
  }, [segments]);

  const stop = () => {
    controller.current?.abort();
    setNowPlaying(null);
    changePhase("stopped");
    void agent.stub.setPlaybackStatus("stopped").catch(() => {});
  };
  const live = !["ready", "stopped", "error"].includes(phase);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="logo">DEVINCAST</span>
        <span className="live">
          <span className={`dot${live ? "" : " off"}`} />
          {live ? "ON AIR" : "OFF AIR"}
        </span>
        <span className="pane-sub">two-host commentary for autonomous coding agents</span>
        <div className="controls">
          <span className="pane-sub">{segments.length} calls</span>
          {live && <button onClick={stop}>STOP</button>}
          {(!live || phase === "idle") && (
            <button onClick={onStart}>{run ? "RESTART DEMO" : "▶ GO LIVE"}</button>
          )}
        </div>
      </header>

      <div className="split">
        <section className="pane" aria-label="The Pitch">
          <div className="pane-head">
            <span className="pane-title">THE PITCH</span>
            <span className="pane-sub">simulated agent · {SESSION.machine}</span>
          </div>
          <div className="session-bar">
            <div className="session-task">
              <span className={`spinner${phase === "terminal" ? "" : " idle"}`} />
              {SESSION.task}
            </div>
            <div className="session-meta">
              <span className="chip">{SESSION.repo}</span>
              <span className="chip branch">⎇ {SESSION.branch}</span>
              <span className="chip">step {current ? current.index + 1 : 0}/{SESSION_STEPS.length}</span>
            </div>
          </div>
          <div className="current-event" role="status">
            <strong>{current ? `${current.index + 1}. ${current.title}` : "A fresh session starts with GO LIVE"}</strong>
            <span>{STATUS[phase]}</span>
          </div>
          <div className="scroll">
            {lines.length === 0 && <div className="line dim">waiting for the agent to start...</div>}
            {lines.map((line) => (
              <div
                className={`line k-${line.kind}${line.eventId === current?.eventId ? " current-line" : " previous-line"}`}
                data-event-id={line.eventId}
                key={line.id}
              >
                <span className="ts">{clock(line.at)}</span>
                <span className="sigil">{PREFIX[line.kind] ?? ""}</span>
                <span className="body">{line.text}</span>
              </div>
            ))}
            <div className="line">
              <span className="ts" />
              <span className="sigil prompt">$</span>
              {phase === "terminal" && <span className="cursor" />}
            </div>
            <div ref={terminalEnd} />
          </div>
        </section>

        <section className="pane" aria-label="The Broadcast">
          <div className="pane-head">
            <span className="pane-title">THE BROADCAST</span>
            <span className="pane-sub">{nowPlaying ? `on air: ${nowPlaying.speakerName}` : STATUS[phase]}</span>
          </div>
          <div className="scroll">
            {segments.length === 0 && (
              <div className="line dim">Commentary will follow the current terminal output.</div>
            )}
            {segments.map((seg) => (
              <div
                className={`seg ${seg.speaker === "A" ? "a" : "b"}${seg.id === nowPlaying?.id ? " speaking" : ""}`}
                data-event-id={seg.eventId}
                key={seg.id}
              >
                <div className="seg-head">
                  <span className="who">{seg.speakerName.toUpperCase()}</span>
                  <span className="tag">{seg.kind === "dead-air" ? "IDLE" : `STEP ${seg.step}`}</span>
                  <span className="tag">{clock(seg.at)}</span>
                  {seg.id === nowPlaying?.id && <span className="tag">SPEAKING</span>}
                </div>
                <div className="seg-event">{seg.title}</div>
                <div className="seg-text">{seg.text}</div>
              </div>
            ))}
            <div ref={broadcastEnd} />
          </div>
          <div className="viz" aria-label="Audio visualizer">
            {levels.map((level, i) => <div className="bar" key={i} style={{ height: `${Math.max(2, level)}%` }} />)}
          </div>
          <div className="footer" role="status">
            <span>{error || startError ? <span className="err">{error || startError}</span> : STATUS[phase]}</span>
            <span>{current ? `linked to step ${current.index + 1}` : "no queued audio"}</span>
          </div>
        </section>
      </div>
    </div>
  );
}
