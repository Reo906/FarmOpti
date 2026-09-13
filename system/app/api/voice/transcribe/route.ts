import { transcribe } from "@/lib/voice/elevenlabs";

const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json(
        { error: "Expected multipart/form-data with an audio field." },
        { status: 400 },
      );
    }

    const form = await request.formData();
    const audioEntry = form.get("audio");
    if (!audioEntry || !(audioEntry instanceof Blob)) {
      return Response.json(
        { error: "Missing audio field in form data." },
        { status: 400 },
      );
    }

    if (audioEntry.size > MAX_AUDIO_BYTES) {
      return Response.json(
        { error: "Audio payload exceeds the 5 MB limit." },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await audioEntry.arrayBuffer());
    const result = await transcribe(buffer);

    return Response.json({
      transcript: result.text,
      languageCode: result.languageCode,
      durationSeconds: result.durationSeconds,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Transcription unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
