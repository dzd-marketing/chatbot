import "server-only";

import {
  credentials,
  Client as GrpcClient,
  status as grpcStatus,
  Metadata,
  type ServiceError,
} from "@grpc/grpc-js";
import protobuf from "protobufjs";
import { getNvidiaKeys } from "./nvidia";

/**
 * DZD Learn's own speech-to-text: the student's recording is transcribed on
 * the server by Whisper large-v3, hosted by NVIDIA and called with the same
 * NVIDIA API keys as the chat models (no extra service or cost). It works
 * the same on every phone and browser, unlike the browser's built-in
 * recognition, and understands English, Sinhala and Tamil.
 *
 * NVIDIA serves it through the Riva speech API, which is gRPC only. The few
 * Riva messages needed are declared inline below (field numbers from
 * nvidia-riva/common riva_asr.proto and riva_audio.proto, MIT), so there are
 * no .proto files to ship with the deployment.
 */

const RIVA_PROTO = `
syntax = "proto3";
package nvidia.riva.asr;

enum AudioEncoding {
  ENCODING_UNSPECIFIED = 0;
  LINEAR_PCM = 1;
}

message RecognitionConfig {
  AudioEncoding encoding = 1;
  int32 sample_rate_hertz = 2;
  string language_code = 3;
  int32 max_alternatives = 4;
  int32 audio_channel_count = 7;
  bool enable_automatic_punctuation = 11;
  map<string, string> custom_configuration = 24;
}

message RecognizeRequest {
  RecognitionConfig config = 1;
  bytes audio = 2;
}

message SpeechRecognitionAlternative {
  string transcript = 1;
  float confidence = 2;
}

message SpeechRecognitionResult {
  repeated SpeechRecognitionAlternative alternatives = 1;
  int32 channel_tag = 2;
  float audio_processed = 3;
}

message RecognizeResponse {
  repeated SpeechRecognitionResult results = 1;
}
`;

const RECOGNIZE_PATH = "/nvidia.riva.asr.RivaSpeechRecognition/Recognize";
const DEFAULT_SERVER = "grpc.nvcf.nvidia.com:443";
/** NVIDIA's hosted openai/whisper-large-v3 (build.nvidia.com). */
const DEFAULT_FUNCTION_ID = "b702f636-f60c-4a3d-a6f4-f3568c13bd7d";
const REQUEST_TIMEOUT_MS = 45_000;
const COOLDOWN_MS = 60_000;

export const SPEECH_SAMPLE_RATE = 16_000;
/** Whisper language codes for the voice languages offered in the app. */
export const SPEECH_LANGUAGES = ["en", "si", "ta"] as const;
export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number];

type RecognizeResponse = {
  results?: { alternatives?: { transcript?: string }[] }[];
};

let messages: {
  request: protobuf.Type;
  response: protobuf.Type;
} | null = null;

function rivaMessages() {
  if (!messages) {
    const { root } = protobuf.parse(RIVA_PROTO, { keepCase: true });
    messages = {
      request: root.lookupType("nvidia.riva.asr.RecognizeRequest"),
      response: root.lookupType("nvidia.riva.asr.RecognizeResponse"),
    };
  }
  return messages;
}

/** Riva request bytes for 16-bit mono PCM audio. */
export function encodeRecognizeRequest(
  pcm: Uint8Array,
  language: SpeechLanguage
) {
  const { request } = rivaMessages();
  return Buffer.from(
    request
      .encode(
        request.create({
          audio: pcm,
          config: {
            audio_channel_count: 1,
            custom_configuration: { task: "transcribe" },
            enable_automatic_punctuation: true,
            encoding: 1, // LINEAR_PCM
            language_code: language,
            max_alternatives: 1,
            sample_rate_hertz: SPEECH_SAMPLE_RATE,
          },
        })
      )
      .finish()
  );
}

/** The transcript in a Riva response (results are consecutive parts). */
export function decodeRecognizeResponse(bytes: Uint8Array) {
  const { response } = rivaMessages();
  const decoded = response.toObject(response.decode(bytes), {
    defaults: true,
  }) as RecognizeResponse;
  return (decoded.results ?? [])
    .map((result) => result.alternatives?.[0]?.transcript?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export class SpeechError extends Error {
  readonly code: "not-configured" | "busy" | "failed";
  constructor(
    code: SpeechError["code"],
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "SpeechError";
    this.code = code;
  }
}

let client: GrpcClient | null = null;
let clientServer = "";

function getClient() {
  const server = process.env.NVIDIA_ASR_SERVER?.trim() || DEFAULT_SERVER;
  if (!client || clientServer !== server) {
    client?.close();
    // A local test server can be used over plain HTTP/2.
    const insecure = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(server);
    client = new GrpcClient(
      server,
      insecure ? credentials.createInsecure() : credentials.createSsl()
    );
    clientServer = server;
  }
  return client;
}

const keyCooldowns = new Map<string, number>();

/** Errors where another key may work (refused, rate limited, overloaded). */
const tryNextKey = (code: number) =>
  code === grpcStatus.UNAUTHENTICATED ||
  code === grpcStatus.PERMISSION_DENIED ||
  code === grpcStatus.RESOURCE_EXHAUSTED ||
  code === grpcStatus.UNAVAILABLE ||
  code === grpcStatus.NOT_FOUND;

function recognize(
  key: string,
  request: Buffer,
  signal?: AbortSignal
): Promise<string> {
  const metadata = new Metadata();
  metadata.set(
    "function-id",
    process.env.NVIDIA_ASR_FUNCTION_ID?.trim() || DEFAULT_FUNCTION_ID
  );
  metadata.set("authorization", `Bearer ${key}`);
  return new Promise((resolve, reject) => {
    const call = getClient().makeUnaryRequest(
      RECOGNIZE_PATH,
      (value: Buffer) => value,
      (value: Buffer) => decodeRecognizeResponse(value),
      request,
      metadata,
      { deadline: Date.now() + REQUEST_TIMEOUT_MS },
      (error: ServiceError | null, text?: string) => {
        signal?.removeEventListener("abort", cancel);
        if (error) {
          reject(error);
        } else {
          resolve(text ?? "");
        }
      }
    );
    function cancel() {
      call.cancel();
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * Transcribes 16 kHz, 16-bit little-endian mono PCM. Tries each NVIDIA key
 * in turn when one is refused or rate limited.
 */
export async function transcribeSpeech(
  pcm: Uint8Array,
  language: SpeechLanguage,
  signal?: AbortSignal
): Promise<string> {
  const keys = getNvidiaKeys();
  if (keys.length === 0) {
    throw new SpeechError("not-configured", "No NVIDIA API key is set.");
  }
  const now = Date.now();
  const ready = keys.filter((key) => (keyCooldowns.get(key) ?? 0) <= now);
  const order = ready.length > 0 ? ready : keys;
  const request = encodeRecognizeRequest(pcm, language);

  let lastError: unknown;
  for (const key of order) {
    try {
      // Keys are tried one after another on purpose (fallback, not fan-out).
      // biome-ignore lint/performance/noAwaitInLoops: sequential fallback
      const text = await recognize(key, request, signal);
      keyCooldowns.delete(key);
      return text;
    } catch (error) {
      lastError = error;
      const code = (error as Partial<ServiceError>).code ?? -1;
      if (signal?.aborted || !tryNextKey(code)) {
        break;
      }
      keyCooldowns.set(key, Date.now() + COOLDOWN_MS);
    }
  }
  const code = (lastError as Partial<ServiceError>)?.code;
  throw new SpeechError(
    code === grpcStatus.RESOURCE_EXHAUSTED || code === grpcStatus.UNAVAILABLE
      ? "busy"
      : "failed",
    "Speech recognition failed.",
    { cause: lastError }
  );
}

/** One-line description of a speech error for logs (no audio, no keys). */
export function describeSpeechError(error: unknown) {
  const cause = error instanceof SpeechError ? error.cause : error;
  const service = cause as Partial<ServiceError> | undefined;
  if (service && typeof service.code === "number") {
    return `grpc ${service.code}: ${String(service.details ?? "").slice(0, 160)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
