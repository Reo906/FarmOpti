import process from "node:process";

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const TTS_URL = (voiceId: string) =>
  `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;

const MAX_TEXT_CHARS = 800;

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY ?? "";
  if (!key) throw new Error("ELEVENLABS_API_KEY is not configured.");
  return key;
}

export interface TranscribeResult {
  text: string;
  languageCode: string;
  durationSeconds: number;
}

export async function transcribe(
  audio: Buffer | Uint8Array,
  opts?: { languageCode?: string; keywords?: string[] },
): Promise<TranscribeResult> {
  const form = new FormData();
  form.append(
    "audio",
    new Blob([audio], { type: "audio/webm" }),
    "recording.webm",
  );
  form.append(
    "model_id",
    process.env.ELEVENLABS_STT_MODEL_ID ?? "scribe_v1",
  );
  if (opts?.languageCode) form.append("language_code", opts.languageCode);
  if (opts?.keywords?.length) {
    for (const kw of opts.keywords) form.append("keyterms", kw);
  }

  let response: Response;
  try {
    response = await fetch(STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey() },
      body: form,
    });
  } catch (exc: any) {
    throw new Error(`ElevenLabs STT request failed: ${exc.message ?? exc}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ElevenLabs STT error (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as {
    text?: string;
    language_code?: string;
    audio_duration?: number;
  };

  return {
    text: (json.text ?? "").trim(),
    languageCode: json.language_code ?? "en",
    durationSeconds: json.audio_duration ?? 0,
  };
}

export async function speak(
  text: string,
  opts?: { voiceId?: string; modelId?: string },
): Promise<Uint8Array> {
  const voiceId =
    opts?.voiceId ??
    process.env.ELEVENLABS_VOICE_ID ??
    "JBFqnCBsd6RMkjVDRZzb";
  const modelId =
    opts?.modelId ??
    process.env.ELEVENLABS_TTS_MODEL_ID ??
    "eleven_flash_v2_5";
  const truncated = text.slice(0, MAX_TEXT_CHARS);

  let response: Response;
  try {
    response = await fetch(TTS_URL(voiceId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey(),
      },
      body: JSON.stringify({
        text: truncated,
        model_id: modelId,
        output_format: "mp3_44100_128",
      }),
    });
  } catch (exc: any) {
    throw new Error(`ElevenLabs TTS request failed: ${exc.message ?? exc}`);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `ElevenLabs TTS error (${response.status}): ${body.slice(0, 200)}`,
    );
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}
