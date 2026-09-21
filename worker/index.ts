import { Agent, callable, getAgentByName, routeAgentRequest, type Connection } from "agents";
import { COMMENTATOR, actionPrompt, deadAirPrompt } from "./commentator";
import { RealtimeCommentator } from "./realtime";

const DEAD_AIR_INTERVAL_SECONDS = 30;
const DEAD_AIR_SILENCE_MS = 25_000;
const HISTORY_LIMIT = 50;

export type UserAction = {
  id: string;
  text: string;
  at: number;
};

export type Segment = {
  id: string;
  speakerName: string;
  text: string;
  kind: "event" | "dead-air";
  eventId: string;
  eventText?: string;
  at: number;
};

export type BroadcastState = {
  eventHistory: UserAction[];
  transcript: Segment[];
  lastEventAt: number;
  onAir: boolean;
  playbackStatus: "active" | "idle" | "stopped";
  idleSince: number;
  pendingClipId: string | null;
};

export type BroadcastClip = Segment & {
  /** base64-encoded WAV from OpenAI Realtime */
  audio: string;
  mimeType: "audio/wav";
};

export class BroadcastAgent extends Agent<Env, BroadcastState> {
  initialState: BroadcastState = {
    eventHistory: [],
    transcript: [],
    lastEventAt: 0,
    onAir: false,
    playbackStatus: "stopped",
    idleSince: 0,
    pendingClipId: null
  };

  private realtime = new RealtimeCommentator();
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
    if (!eventText.trim() || !eventId.trim()) throw new Error("An event ID and action description are required");
    if (this.producing || this.state.pendingClipId) {
      throw new Error("Finish the current commentary before submitting another action");
    }
    const event: UserAction = {
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
    if (status === "stopped") this.realtime.close();
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
    event: UserAction
  ): Promise<BroadcastClip> {
    this.producing = true;
    const revision = this.revision;
    try {
      return await this.keepAliveWhile(async () => {
        if (revision !== this.revision) throw new Error("Broadcast was cancelled");
        const prompt = kind === "event" ? actionPrompt(event.text) : deadAirPrompt(event.text);
        const line = await this.realtime.commentate(this.env, prompt);
        if (revision !== this.revision) throw new Error("Broadcast was cancelled");

        const segment: Segment = {
          id: crypto.randomUUID(),
          speakerName: COMMENTATOR.name,
          text: line.text,
          kind,
          eventId: event.id,
          eventText: event.text,
          at: Date.now()
        };

        this.setState({
          ...this.state,
          transcript: [...this.state.transcript, segment].slice(-HISTORY_LIMIT),
          pendingClipId: segment.id
        });

        const clip: BroadcastClip = { ...segment, audio: line.audio, mimeType: "audio/wav" };
        this.broadcast(JSON.stringify({ type: "clip", clip }));
        return clip;
      });
    } finally {
      this.producing = false;
    }
  }
}

type AgentStub = {
  processEvent: (text: string, eventId?: string) => Promise<BroadcastClip>;
  acknowledgeClip: (clipId: string) => Promise<void>;
  setPlaybackStatus: (status: BroadcastState["playbackStatus"]) => Promise<void>;
  getTranscript: () => Promise<Segment[]>;
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type"
};

const METHODS: Record<string, (stub: AgentStub, args: unknown[]) => Promise<unknown>> = {
  processEvent: (stub, [text, eventId]) =>
    stub.processEvent(String(text), eventId === undefined ? undefined : String(eventId)),
  acknowledgeClip: (stub, [clipId]) => stub.acknowledgeClip(String(clipId)),
  setPlaybackStatus: (stub, [status]) =>
    stub.setPlaybackStatus(status as BroadcastState["playbackStatus"]),
  getTranscript: (stub) => stub.getTranscript()
};

async function handleSessionCall(request: Request, env: Env, name: string): Promise<Response> {
  let body: { method?: string; args?: unknown[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body" }, { status: 400, headers: CORS });
  }
  const handler = body.method ? METHODS[body.method] : undefined;
  if (!handler) return Response.json({ error: "Unknown method" }, { status: 404, headers: CORS });
  try {
    const stub = (await getAgentByName(env.BroadcastAgent, name)) as unknown as AgentStub;
    const result = await handler(stub, Array.isArray(body.args) ? body.args : []);
    return Response.json({ result }, { headers: CORS });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: CORS }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const sessionCall = url.pathname.match(/^\/sessions\/([A-Za-z0-9_-]{1,64})\/call$/);
    if (request.method === "OPTIONS" && sessionCall) {
      return new Response(null, { headers: CORS });
    }
    if (request.method === "POST" && sessionCall) {
      return handleSessionCall(request, env, sessionCall[1]);
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok");
    }
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
