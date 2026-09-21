import { Agent, callable, routeAgentRequest, type Connection } from "agents";
import { synthesize, toBase64 } from "./elevenlabs";
import { commentOnEvent, deadAirBanter } from "./llm";
import { PERSONAS, otherSpeaker, type SpeakerId } from "./personas";

const DEAD_AIR_INTERVAL_SECONDS = 30;
const DEAD_AIR_SILENCE_MS = 25_000;
const TRANSCRIPT_CONTEXT = 6;
const HISTORY_LIMIT = 50;

export type CodingEvent = {
  id: string;
  text: string;
  at: number;
};

export type Segment = {
  id: string;
  speaker: SpeakerId;
  speakerName: string;
  text: string;
  kind: "event" | "dead-air";
  eventId: string;
  eventText?: string;
  at: number;
};

export type BroadcastState = {
  eventHistory: CodingEvent[];
  transcript: Segment[];
  nextSpeaker: SpeakerId;
  lastEventAt: number;
  onAir: boolean;
  playbackStatus: "active" | "idle" | "stopped";
  idleSince: number;
  pendingClipId: string | null;
};

export type BroadcastClip = Segment & {
  /** base64-encoded mp3 from ElevenLabs */
  audio: string;
  mimeType: "audio/mpeg";
};

export class BroadcastAgent extends Agent<Env, BroadcastState> {
  initialState: BroadcastState = {
    eventHistory: [],
    transcript: [],
    nextSpeaker: "A",
    lastEventAt: 0,
    onAir: false,
    playbackStatus: "stopped",
    idleSince: 0,
    pendingClipId: null
  };

  private producing = false;
  private revision = 0;

  async onStart() {
    // Idempotent: one interval survives hibernation and restarts.
    await this.scheduleEvery(DEAD_AIR_INTERVAL_SECONDS, "checkDeadAir");
  }

  @callable()
  async processEvent(
    eventText: string,
    eventId: string = crypto.randomUUID()
  ): Promise<BroadcastClip> {
    if (!eventText.trim() || !eventId.trim()) throw new Error("An event ID and terminal output are required");
    if (this.producing || this.state.pendingClipId) {
      throw new Error("Finish the current commentary before submitting another event");
    }
    const event: CodingEvent = {
      id: eventId,
      text: eventText,
      at: Date.now()
    };
    this.setState({
      ...this.state,
      eventHistory: [...this.state.eventHistory, event].slice(-HISTORY_LIMIT),
      lastEventAt: event.at,
      onAir: true,
      playbackStatus: "active",
      idleSince: 0
    });

    return this.produce("event", event);
  }

  @callable()
  setPlaybackStatus(status: BroadcastState["playbackStatus"]) {
    if (!["active", "idle", "stopped"].includes(status)) {
      throw new Error("Invalid playback status");
    }
    this.revision += 1;
    this.setState({
      ...this.state,
      onAir: status !== "stopped",
      playbackStatus: status,
      idleSince: status === "idle" ? Date.now() : 0,
      pendingClipId: status === "stopped" ? null : this.state.pendingClipId
    });
  }

  @callable()
  acknowledgeClip(clipId: string) {
    if (this.state.pendingClipId !== clipId) return;
    this.setState({
      ...this.state,
      pendingClipId: null,
      idleSince: this.state.playbackStatus === "idle" ? Date.now() : 0
    });
  }

  @callable()
  getTranscript(): Segment[] {
    return this.state.transcript;
  }

  async checkDeadAir() {
    const event = this.state.eventHistory.at(-1);
    if (
      !event ||
      !this.state.onAir ||
      this.state.playbackStatus !== "idle" ||
      this.producing ||
      this.state.pendingClipId ||
      Date.now() - this.state.idleSince < DEAD_AIR_SILENCE_MS ||
      !Array.from(this.getConnections()).length
    ) return;
    try {
      await this.produce("dead-air", event);
    } catch (error) {
      if (this.state.playbackStatus === "idle") {
        this.setState({ ...this.state, idleSince: Date.now() });
        this.broadcast(JSON.stringify({
          type: "broadcast-error",
          message: error instanceof Error ? error.message : String(error)
        }));
      }
    }
  }

  onClose(connection: Connection) {
    if (!Array.from(this.getConnections()).some((other) => other.id !== connection.id)) {
      this.setPlaybackStatus("stopped");
    }
  }

  private async produce(
    kind: "event" | "dead-air",
    event: CodingEvent
  ): Promise<BroadcastClip> {
    this.producing = true;
    const revision = this.revision;
    try {
      return await this.keepAliveWhile(async () => {
        if (revision !== this.revision) throw new Error("Broadcast was cancelled");
        const speaker = this.state.nextSpeaker;
        const persona = PERSONAS[speaker];
        const context = this.state.transcript
          .slice(-TRANSCRIPT_CONTEXT)
          .map((s) => `${s.speakerName}: ${s.text}`);

        const text =
          kind === "event"
            ? await commentOnEvent(this.env, persona, event.text)
            : await deadAirBanter(this.env, persona, event.text, context);

        if (revision !== this.revision) throw new Error("Broadcast was cancelled");

        const audio = toBase64(await synthesize(this.env, persona.voiceId, text));
        if (revision !== this.revision) throw new Error("Broadcast was cancelled");

        const segment: Segment = {
          id: crypto.randomUUID(),
          speaker,
          speakerName: persona.name,
          text,
          kind,
          eventId: event.id,
          eventText: event.text,
          at: Date.now()
        };

        this.setState({
          ...this.state,
          transcript: [...this.state.transcript, segment].slice(-HISTORY_LIMIT),
          nextSpeaker: otherSpeaker(speaker),
          pendingClipId: segment.id
        });

        const clip: BroadcastClip = { ...segment, audio, mimeType: "audio/mpeg" };
        this.broadcast(JSON.stringify({ type: "clip", clip }));
        return clip;
      });
    } finally {
      this.producing = false;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routeAgentRequest(request, env)) ??
      env.ASSETS.fetch(request)
    );
  }
} satisfies ExportedHandler<Env>;
