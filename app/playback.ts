import type { BroadcastClip } from "../worker";
import type { SessionLine, SessionStep } from "./session";

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function runSession(options: {
  steps: SessionStep[];
  signal: AbortSignal;
  onStep: (step: SessionStep, index: number, eventId: string) => void;
  onLine: (line: SessionLine, eventId: string) => void;
  afterRender: () => Promise<void>;
  generate: (eventText: string, eventId: string) => Promise<BroadcastClip>;
  play: (clip: BroadcastClip) => Promise<void>;
}) {
  const { steps, signal, onStep, onLine, afterRender, generate, play } = options;
  for (const [index, step] of steps.entries()) {
    signal.throwIfAborted();
    const eventId = crypto.randomUUID();
    onStep(step, index, eventId);
    for (const line of step.lines) {
      await waitFor(line.delay ?? 180, signal);
      signal.throwIfAborted();
      onLine(line, eventId);
    }
    await afterRender();
    signal.throwIfAborted();
    const terminalOutput = step.lines
      .map((line) => line.kind === "cmd" ? `$ ${line.text}` : line.text)
      .join("\n");
    const clip = await generate(terminalOutput, eventId);
    signal.throwIfAborted();
    if (clip.eventId !== eventId || clip.kind !== "event") {
      throw new Error("Commentary does not match the current terminal event");
    }
    await play(clip);
    signal.throwIfAborted();
  }
}
