import { auth } from "@/app/(auth)/auth";
import { getDzdToken } from "@/lib/ai/dzd";

/**
 * The DZD voice for voice conversations: forwards a sentence to the voice
 * Space (Kyutai Pocket TTS speaking in the DZD voice) and streams the audio
 * back as it's made: raw 16-bit mono PCM, sample rate in X-Sample-Rate.
 *
 * GET wakes the Space and reports whether the voice is ready, so a call
 * can fall back to the device's voice when it isn't.
 *
 * The Space's token stays on the server: HF_READ_TOKEN (needed while the
 * Space is private) and, if the Space is public with a key, VOICE_SPACE_KEY.
 */

export const maxDuration = 60;

const DEFAULT_SPACE_URL =
  "https://danuka21-quizontal-background-remover-c1.hf.space";
const MAX_CHARS = 600;
/** The Space must start sending audio within this time. */
const FIRST_AUDIO_TIMEOUT_MS = 8000;
const HEALTH_TIMEOUT_MS = 6000;

function spaceUrl() {
  return (process.env.VOICE_SPACE_URL || DEFAULT_SPACE_URL).replace(/\/+$/, "");
}

function spaceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const token = getDzdToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (process.env.VOICE_SPACE_KEY) {
    headers["x-voice-key"] = process.env.VOICE_SPACE_KEY;
  }
  return headers;
}

class VoiceTimeoutError extends Error {
  constructor() {
    super("The voice took too long to start");
    this.name = "VoiceTimeoutError";
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ ok: false }, { status: 401 });
  }
  try {
    const response = await fetch(`${spaceUrl()}/health`, {
      cache: "no-store",
      headers: spaceHeaders(),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return Response.json({ ok: false }, { status: 503 });
    }
    const health = (await response.json()) as {
      sample_rate?: number;
      voice?: string;
    };
    return Response.json(
      { ok: true, sampleRate: health.sample_rate, voice: health.voice },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let text = "";
  try {
    const body = (await request.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    // Handled below.
  }
  text = text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return Response.json({ error: "no text" }, { status: 400 });
  }

  // Stops the Space's work when the student interrupts (or it's too slow).
  const upstream = new AbortController();
  const abort = () => upstream.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => upstream.abort(new VoiceTimeoutError()),
    FIRST_AUDIO_TIMEOUT_MS
  );

  let response: Response;
  try {
    response = await fetch(`${spaceUrl()}/tts`, {
      body: JSON.stringify({ text }),
      cache: "no-store",
      headers: { ...spaceHeaders(), "Content-Type": "application/json" },
      method: "POST",
      signal: upstream.signal,
    });
  } catch {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    return Response.json({ error: "voice unavailable" }, { status: 503 });
  }
  if (!(response.ok && response.body)) {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    return Response.json(
      { error: "voice unavailable" },
      { status: response.status === 503 ? 503 : 502 }
    );
  }

  const reader = response.body.getReader();
  let started = false;
  const finish = () => {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
  };
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      finish();
      upstream.abort();
      reader.cancel().catch(() => undefined);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!started) {
          // Audio is flowing: no more time limit (the reply may be long).
          started = true;
          clearTimeout(timer);
        }
        if (done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "X-Accel-Buffering": "no",
      "X-Sample-Rate": response.headers.get("x-sample-rate") ?? "24000",
    },
  });
}
