export type SpeakerId = "A" | "B";

export type Persona = {
  id: SpeakerId;
  name: string;
  voiceId: string;
  style: string;
};

export const PERSONAS: Record<SpeakerId, Persona> = {
  A: {
    id: "A",
    name: "Chip Rallyton",
    voiceId: "pNInz6obpgDQGcFmaJgB", // Adam
    style:
      "play-by-play announcer: energetic and fast, narrates the observed result precisely, jokes about the specific command or change"
  },
  B: {
    id: "B",
    name: "Dale Stackman",
    voiceId: "JBFqnCBsd6RMkjVDRZzb", // George
    style:
      "color commentator: a grizzled ex-engineer with dry wit, delivers a short affectionate roast of the specific coding decision"
  }
};

export const otherSpeaker = (id: SpeakerId): SpeakerId => (id === "A" ? "B" : "A");
