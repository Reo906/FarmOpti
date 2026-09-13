import { speak } from "@/lib/voice/elevenlabs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return Response.json(
        { error: "Provide a non-empty text field." },
        { status: 400 },
      );
    }

    const audio = await speak(text);
    return new Response(audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Speech synthesis unavailable.";
    return Response.json({ error: message }, { status: 503 });
  }
}
