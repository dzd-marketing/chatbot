import { auth } from "@/app/(auth)/auth";
import {
  describeSpeechError,
  SPEECH_LANGUAGES,
  SPEECH_SAMPLE_RATE,
  SpeechError,
  type SpeechLanguage,
  transcribeSpeech,
} from "@/lib/ai/speech";

export const maxDuration = 60;

/**
 * Speech-to-text for voice messages. The browser sends one piece of the
 * recording (up to about a minute) as raw 16 kHz, 16-bit mono PCM, and gets
 * the transcript back. Long recordings arrive as several pieces.
 */

/** 70 s of audio: pieces are cut at about 55 s, so this leaves headroom. */
const MAX_BYTES = SPEECH_SAMPLE_RATE * 2 * 70;
/** Shorter than this is a tap, not speech. */
const MIN_BYTES = SPEECH_SAMPLE_RATE * 2 * 0.2;

const isLanguage = (value: string | null): value is SpeechLanguage =>
  (SPEECH_LANGUAGES as readonly string[]).includes(value ?? "");

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "Please sign in." }, { status: 401 });
  }

  const language = new URL(request.url).searchParams.get("lang");
  if (!isLanguage(language)) {
    return Response.json({ error: "Unknown language." }, { status: 400 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    return Response.json({ error: "Recording is too long." }, { status: 413 });
  }

  const audio = new Uint8Array(await request.arrayBuffer());
  if (audio.byteLength > MAX_BYTES) {
    return Response.json({ error: "Recording is too long." }, { status: 413 });
  }
  if (audio.byteLength < MIN_BYTES) {
    return Response.json({ text: "" });
  }
  // Whole 16-bit samples only.
  const pcm =
    audio.byteLength % 2 === 0
      ? audio
      : audio.subarray(0, audio.byteLength - 1);

  try {
    const text = await transcribeSpeech(pcm, language, request.signal);
    return Response.json({ text });
  } catch (error) {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    console.warn(`[dzd-speech] ${language}: ${describeSpeechError(error)}`);
    if (error instanceof SpeechError && error.code === "not-configured") {
      return Response.json(
        { error: "Voice transcription isn't set up yet." },
        { status: 503 }
      );
    }
    return Response.json(
      {
        error:
          error instanceof SpeechError && error.code === "busy"
            ? "Voice transcription is busy. Please try again in a moment."
            : "Couldn't transcribe the recording.",
      },
      { status: 502 }
    );
  }
}
