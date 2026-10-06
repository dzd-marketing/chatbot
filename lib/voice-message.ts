import type { UIMessage } from "ai";
import type { VoiceData } from "@/lib/types";

/**
 * Voice messages: the student's recording is stored as an audio file part
 * (for playback), next to a `data-voice` part with the transcript's words
 * and timings, and the transcript itself as the text part. Models can't
 * hear audio, so the audio part is replaced by a short note before a
 * request and the model reads the transcript.
 */

export const VOICE_AUDIO_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
  "audio/mpeg",
] as const;
export type VoiceAudioType = (typeof VOICE_AUDIO_TYPES)[number];

/** Longest voice message (the transcript must fit a 2000-character part). */
export const MAX_VOICE_MS = 5 * 60 * 1000;
export const MAX_VOICE_WORDS = 600;

/** "audio/webm;codecs=opus" -> "audio/webm"; null if not supported. */
export function normalizeAudioType(type: string): VoiceAudioType | null {
  const base = type.split(";")[0].trim().toLowerCase();
  if (base === "audio/x-m4a" || base === "audio/aac") {
    return "audio/mp4";
  }
  return (VOICE_AUDIO_TYPES as readonly string[]).includes(base)
    ? (base as VoiceAudioType)
    : null;
}

export function audioExtension(type: VoiceAudioType) {
  return {
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
  }[type];
}

type AnyPart = UIMessage["parts"][number] | { type: string };

export const isVoiceAudioPart = (part: AnyPart): boolean =>
  part.type === "file" &&
  "mediaType" in part &&
  typeof part.mediaType === "string" &&
  part.mediaType.startsWith("audio/");

/**
 * Pairs the transcript's words with the times they were first heard.
 * `heardAt[i]` is when word i appeared (ms into the recording, may be
 * missing for words that were corrected later). Missing times are spread
 * evenly up to the end, and times never go backwards.
 */
export function buildVoiceData(
  transcript: string,
  heardAt: readonly number[],
  duration: number
): VoiceData {
  const words = transcript
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_VOICE_WORDS);
  const end = Math.max(0, Math.round(duration));
  const starts: number[] = [];
  let index = 0;
  while (index < words.length) {
    const known = heardAt[index];
    if (typeof known === "number" && Number.isFinite(known)) {
      starts.push(known);
      index += 1;
      continue;
    }
    // A run of unknown times: spread between the neighbours.
    let next = index;
    while (
      next < words.length &&
      !Number.isFinite(heardAt[next] ?? Number.NaN)
    ) {
      next += 1;
    }
    const from = starts.at(-1) ?? 0;
    const to = next < words.length ? (heardAt[next] as number) : end;
    const gap = (Math.max(from, to) - from) / (next - index + 1);
    for (let fill = index; fill < next; fill += 1) {
      starts.push(from + gap * (fill - index + 1));
    }
    index = next;
  }
  let previous = 0;
  return {
    duration: end,
    words: words.map((text, position) => {
      const start = Math.round(
        Math.min(end, Math.max(previous, starts[position] ?? previous))
      );
      previous = start;
      return { start, text: text.slice(0, 100) };
    }),
  };
}

/** The word being spoken at `timeMs` (0 before the first word). */
export function spokenWordIndex(data: VoiceData, timeMs: number) {
  let index = 0;
  for (let position = 0; position < data.words.length; position += 1) {
    if (data.words[position].start <= timeMs) {
      index = position;
    } else {
      break;
    }
  }
  return index;
}

/** Before a model request: the audio becomes a note about the transcript. */
export function voiceMessagesForModel<T extends UIMessage>(messages: T[]): T[] {
  return messages.map((message) => {
    if (!message.parts.some(isVoiceAudioPart)) {
      return message;
    }
    const parts = message.parts.map((part) =>
      isVoiceAudioPart(part)
        ? {
            text: "[The student sent a voice message. The text below is the browser's transcript of it, so it may contain small recognition mistakes.]",
            type: "text" as const,
          }
        : part
    );
    return { ...message, parts };
  });
}
