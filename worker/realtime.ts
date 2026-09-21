import { COMMENTATOR } from "./commentator";

const PCM_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 15_000;
const RESPONSE_TIMEOUT_MS = 45_000;

export type SpokenLine = {
  text: string;
  /** base64 WAV, 24kHz mono PCM16 */
  audio: string;
};

type PendingResponse = {
  resolve: (line: SpokenLine) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  pcm: Uint8Array[];
  transcript: string;
};

type ServerEvent = {
  type?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
  response?: {
    status?: string;
    status_details?: { error?: { message?: string }; reason?: string };
    output?: {
      content?: { type?: string; transcript?: string }[];
    }[];
  };
};

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Wrap raw 24kHz mono PCM16 samples in a RIFF/WAV container. */
export function encodeWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, PCM_RATE, true);
  view.setUint32(28, PCM_RATE * 2, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return wav;
}

/**
 * One persistent OpenAI Realtime speech session that voices every commentary
 * line. Conversation history accumulates inside the session, so each line is
 * grounded in what the commentator has already seen.
 */
export class RealtimeCommentator {
  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private openResolve: (() => void) | null = null;
  private openReject: ((error: Error) => void) | null = null;
  private pending: PendingResponse | null = null;

  async commentate(env: Env, prompt: string): Promise<SpokenLine> {
    if (this.pending) throw new Error("A commentary response is already in progress");
    await this.ensureConnected(env);
    const ws = this.ws;
    if (!ws) throw new Error("Realtime session is not connected");

    const line = await new Promise<SpokenLine>((resolve, reject) => {
      const pending: PendingResponse = {
        resolve,
        reject,
        pcm: [],
        transcript: "",
        timer: setTimeout(() => {
          this.fail(new Error("Realtime response timed out"));
        }, RESPONSE_TIMEOUT_MS)
      };
      this.pending = pending;
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }]
        }
      }));
      ws.send(JSON.stringify({ type: "response.create" }));
    });
    return line;
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
    this.settle(new Error("Realtime session closed"), false);
  }

  private async ensureConnected(env: Env): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.opening) return;
    if (this.opening) return this.opening;
    if (!env.OPENAI_API_KEY) throw new Error("No OPENAI_API_KEY configured");

    const model = env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
    const res = await fetch(
      `https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: {
          Upgrade: "websocket",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        }
      }
    );
    const ws = res.webSocket;
    if (!ws) {
      throw new Error(`Realtime handshake failed: ${res.status} ${await res.text()}`);
    }
    this.ws = ws;
    ws.accept();
    ws.addEventListener("message", (event) => this.onMessage(event));
    ws.addEventListener("close", () => this.fail(new Error("Realtime session disconnected")));
    ws.addEventListener("error", () => this.fail(new Error("Realtime session error")));

    this.opening = new Promise<void>((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      setTimeout(() => {
        if (this.opening) this.fail(new Error("Realtime session setup timed out"));
      }, CONNECT_TIMEOUT_MS);
    });

    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "realtime",
        model,
        instructions: COMMENTATOR.instructions,
        output_modalities: ["audio"],
        audio: {
          output: {
            format: { type: "audio/pcm", rate: PCM_RATE },
            voice: env.OPENAI_REALTIME_VOICE ?? COMMENTATOR.defaultVoice
          }
        }
      }
    }));

    try {
      await this.opening;
    } finally {
      this.opening = null;
      this.openResolve = null;
      this.openReject = null;
    }
  }

  private onMessage(event: MessageEvent) {
    let data: ServerEvent;
    try {
      data = JSON.parse(String(event.data)) as ServerEvent;
    } catch {
      return;
    }
    switch (data.type) {
      case "session.updated":
        this.openResolve?.();
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (data.delta) this.pending?.pcm.push(fromBase64(data.delta));
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (data.delta) this.pending && (this.pending.transcript += data.delta);
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (data.transcript && this.pending && !this.pending.transcript) {
          this.pending.transcript = data.transcript;
        }
        break;
      case "response.done":
        this.finishResponse(data);
        break;
      case "error":
        this.fail(new Error(data.error?.message ?? "Realtime API error"));
        break;
    }
  }

  private finishResponse(event: ServerEvent) {
    const pending = this.pending;
    if (!pending) return;
    const response = event.response;
    if (response?.status && response.status !== "completed") {
      const detail = response.status_details?.error?.message
        ?? response.status_details?.reason
        ?? response.status;
      this.fail(new Error(`Realtime response ${response.status}: ${detail}`));
      return;
    }
    let transcript = pending.transcript.trim();
    if (!transcript) {
      for (const item of response?.output ?? []) {
        for (const content of item.content ?? []) {
          if (content.transcript) transcript = content.transcript.trim();
        }
      }
    }
    const size = pending.pcm.reduce((total, part) => total + part.length, 0);
    const pcm = new Uint8Array(size);
    let offset = 0;
    for (const part of pending.pcm) {
      pcm.set(part, offset);
      offset += part.length;
    }
    this.pending = null;
    clearTimeout(pending.timer);
    if (!pcm.length) {
      pending.reject(new Error("Realtime returned no audio"));
      return;
    }
    pending.resolve({ text: transcript, audio: toBase64(encodeWav(pcm)) });
  }

  private fail(error: Error) {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch {}
    this.settle(error, true);
  }

  private settle(error: Error, rejectOpen: boolean) {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    if (rejectOpen) this.openReject?.(error);
  }
}
