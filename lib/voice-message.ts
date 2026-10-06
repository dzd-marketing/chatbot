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

/* ------------------------------------------------------------------ sync */

/** Microphone loudness (0..1) sampled while recording; `t` is ms into it. */
export type VoiceEnvelope = { t: number; v: number }[];

/** Recognition can't report a word before this long after it started. */
const MIN_RECOGNITION_LAG_MS = 300;
/** Used when there is no loudness data: a typical recognition delay. */
const FALLBACK_LAG_MS = 650;
/** Highlight a hair early so it reads as "on" the sound. */
const LEAD_MS = 40;

function percentile(sorted: number[], share: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

/** Rough spoken length of a word (vowel groups for Latin script). */
function wordWeight(word: string) {
  const latin = word.toLowerCase().match(/[aeiouy]+/g);
  return latin ? 1 + latin.length : 1 + Math.min(6, word.length / 2);
}

/** Runs of speech in the recording, after closing short gaps and blips. */
export function speechSegments(envelope: VoiceEnvelope) {
  if (envelope.length < 10) {
    return null;
  }
  const values = envelope.map((sample) => sample.v);
  const sorted = [...values].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.15);
  const peak = percentile(sorted, 0.95);
  if (peak - floor < 0.08) {
    return null; // no clear speech/silence contrast
  }
  const threshold = floor + (peak - floor) * 0.3;
  const runs: { start: number; end: number }[] = [];
  for (const [index, sample] of envelope.entries()) {
    if (values[index] <= threshold) {
      continue;
    }
    const next = envelope[index + 1]?.t ?? sample.t + 20;
    const last = runs.at(-1);
    // Gaps under 200 ms are pauses inside words or between close words.
    if (last && sample.t - last.end < 200) {
      last.end = next;
    } else {
      runs.push({ end: next, start: sample.t });
    }
  }
  const segments = runs.filter((run) => run.end - run.start >= 80);
  return segments.length > 0 ? segments : null;
}

/**
 * Word timings from the recording itself: the loudness shows where speech
 * actually is, and the recogniser's (late) timestamps only decide which
 * stretch of speech each word belongs to. Inside a stretch, words share
 * the time by their rough spoken length. Without usable loudness data it
 * falls back to the recogniser's timestamps minus a typical delay.
 */
export function alignVoiceWords(
  transcript: string,
  heardAt: readonly number[],
  envelope: VoiceEnvelope,
  duration: number
): VoiceData {
  const words = transcript
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_VOICE_WORDS);
  const segments = speechSegments(envelope);
  if (!segments || words.length === 0) {
    return buildVoiceData(
      transcript,
      heardAt.map((time) => Math.max(0, time - FALLBACK_LAG_MS)),
      duration
    );
  }

  // Which stretch each word was spoken in (never going backwards).
  const owner: number[] = [];
  let current = 0;
  for (let index = 0; index < words.length; index += 1) {
    const heard = heardAt[index];
    if (typeof heard === "number" && Number.isFinite(heard)) {
      let segment = 0;
      for (const [position, candidate] of segments.entries()) {
        if (candidate.start <= heard - MIN_RECOGNITION_LAG_MS) {
          segment = position;
        }
      }
      current = Math.max(current, segment);
    }
    owner.push(current);
  }

  const starts: number[] = new Array(words.length).fill(0);
  for (const [position, segment] of segments.entries()) {
    const members = owner.flatMap((value, index) =>
      value === position ? [index] : []
    );
    if (members.length === 0) {
      continue;
    }
    const weights = members.map((index) => wordWeight(words[index]));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsed = 0;
    for (const [order, index] of members.entries()) {
      starts[index] =
        segment.start + ((segment.end - segment.start) * elapsed) / total;
      elapsed += weights[order];
    }
  }

  return buildVoiceData(
    transcript,
    starts.map((start) => Math.max(0, start - LEAD_MS)),
    duration
  );
}
