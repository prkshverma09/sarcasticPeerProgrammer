type Env = {
  ELEVENLABS_API_KEY?: string;
  ELEVENLABS_MODEL_ID?: string;
};

export async function synthesize(
  env: Env,
  voiceId: string,
  text: string
): Promise<ArrayBuffer> {
  if (!env.ELEVENLABS_API_KEY) throw new Error("No ELEVENLABS_API_KEY configured");

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "xi-api-key": env.ELEVENLABS_API_KEY
      },
      body: JSON.stringify({
        text,
        model_id: env.ELEVENLABS_MODEL_ID ?? "eleven_flash_v2_5",
        voice_settings: { stability: 0.35, similarity_boost: 0.75, style: 0.6 }
      }),
      signal: AbortSignal.timeout(30_000)
    }
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs request failed: ${res.status} ${await res.text()}`);
  }
  return res.arrayBuffer();
}

export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
