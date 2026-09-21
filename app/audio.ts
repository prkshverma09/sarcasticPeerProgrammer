import type { BroadcastClip } from "../worker";

export async function playAudio(
  clip: BroadcastClip,
  ctx: AudioContext,
  analyser: AnalyserNode,
  signal: AbortSignal,
  onStarted: () => void
): Promise<void> {
  signal.throwIfAborted();
  await ctx.resume();
  signal.throwIfAborted();
  const blob = new Blob([Uint8Array.from(atob(clip.audio), (c) => c.charCodeAt(0))], {
    type: clip.mimeType
  });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const source = ctx.createMediaElementSource(audio);
  source.connect(analyser);
  let abort: () => void = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      audio.onplaying = () => {
        audio.onplaying = null;
        onStarted();
      };
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Audio could not be decoded or played"));
      timeout = setTimeout(() => reject(new Error("Audio playback stalled")), 90_000);
      void audio.play().catch(reject);
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    audio.onplaying = null;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    source.disconnect();
    URL.revokeObjectURL(url);
  }
}
