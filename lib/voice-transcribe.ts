/**
 * Browser half of DZD Learn's speech-to-text (server half: lib/ai/speech.ts).
 * The finished recording is decoded, turned into 16 kHz mono 16-bit PCM
 * (the format the recogniser wants), trimmed of silence at both ends, cut
 * into pieces of under a minute at quiet moments (requests to the server
 * must stay small), and the pieces are transcribed in parallel.
 */

export const TRANSCRIBE_RATE = 16_000;
/** Pieces are cut between these lengths, at the quietest moment. */
const PIECE_MIN_S = 40;
const PIECE_MAX_S = 55;
const WINDOW_S = 0.05;
/** Below this loudness (RMS) a 50 ms window counts as silence. */
const SILENCE_RMS = 0.012;
/** Kept around the speech when trimming silence. */
const PAD_S = 0.35;

export class TranscribeError extends Error {
  /** HTTP status from the server; 0 when the recording couldn't be read. */
  readonly status: number;
  constructor(message: string, options: { status: number; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "TranscribeError";
    this.status = options.status;
  }
}

/** Mono samples from any recording the browser can play. */
async function decodeRecording(blob: Blob) {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  const context = new Context();
  try {
    const data = await blob.arrayBuffer();
    // Safari's old callback form also returns a promise in current versions.
    const audio = await context.decodeAudioData(data);
    const mono = new Float32Array(audio.length);
    for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
      const samples = audio.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1) {
        mono[index] += samples[index] / audio.numberOfChannels;
      }
    }
    return { rate: audio.sampleRate, samples: mono };
  } finally {
    context.close().catch(() => undefined);
  }
}

/**
 * Resamples to 16 kHz: averaging when going down (which also filters out
 * the highs that would alias), linear interpolation when going up.
 */
export function resample(samples: Float32Array, rate: number) {
  if (rate === TRANSCRIBE_RATE) {
    return samples;
  }
  const ratio = rate / TRANSCRIBE_RATE;
  const length = Math.floor(samples.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const start = index * ratio;
    if (ratio > 1) {
      const from = Math.floor(start);
      const to = Math.min(
        samples.length,
        Math.max(from + 1, Math.floor(start + ratio))
      );
      let sum = 0;
      for (let position = from; position < to; position += 1) {
        sum += samples[position];
      }
      output[index] = sum / (to - from);
    } else {
      const from = Math.floor(start);
      const next = Math.min(samples.length - 1, from + 1);
      const share = start - from;
      output[index] = samples[from] * (1 - share) + samples[next] * share;
    }
  }
  return output;
}

/** Loudness (RMS) of each 50 ms window of 16 kHz audio. */
function windowLevels(samples: Float32Array) {
  const size = Math.round(TRANSCRIBE_RATE * WINDOW_S);
  const levels: number[] = [];
  for (let start = 0; start < samples.length; start += size) {
    const end = Math.min(samples.length, start + size);
    let sum = 0;
    for (let index = start; index < end; index += 1) {
      sum += samples[index] * samples[index];
    }
    levels.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  return { levels, size };
}

/**
 * Splits 16 kHz audio into pieces with speech: silence at both ends is
 * dropped, and long audio is cut at the quietest moment between 40 and
 * 55 seconds into each piece. Returns no pieces if nothing was said.
 */
export function speechPieces(samples: Float32Array) {
  const { levels, size } = windowLevels(samples);
  const first = levels.findIndex((level) => level > SILENCE_RMS);
  if (first === -1) {
    return [];
  }
  const last = levels.findLastIndex((level) => level > SILENCE_RMS);
  const pad = Math.round(PAD_S / WINDOW_S);
  let start = Math.max(0, first - pad) * size;
  const end = Math.min(samples.length, (last + 1 + pad) * size);

  const pieces: Float32Array[] = [];
  const minLength = PIECE_MIN_S * TRANSCRIBE_RATE;
  const maxLength = PIECE_MAX_S * TRANSCRIBE_RATE;
  while (end - start > maxLength) {
    let cut = start + maxLength;
    let quietest = Number.POSITIVE_INFINITY;
    const fromWindow = Math.ceil((start + minLength) / size);
    const toWindow = Math.floor((start + maxLength) / size);
    for (let window = fromWindow; window < toWindow; window += 1) {
      if (levels[window] < quietest) {
        quietest = levels[window];
        cut = window * size;
      }
    }
    pieces.push(samples.subarray(start, cut));
    start = cut;
  }
  pieces.push(samples.subarray(start, end));
  return pieces;
}

/** 16-bit little-endian PCM bytes. */
export function toPcm16(samples: Float32Array) {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(
      index * 2,
      value < 0 ? value * 0x80_00 : value * 0x7f_ff,
      true
    );
  }
  return view.buffer;
}

async function transcribePiece(
  pcm: ArrayBuffer,
  language: string,
  signal?: AbortSignal
) {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/voice/transcribe?lang=${encodeURIComponent(language)}`,
    {
      body: pcm,
      headers: { "Content-Type": "application/octet-stream" },
      method: "POST",
      signal,
    }
  );
  const result = (await response.json().catch(() => ({}))) as {
    text?: string;
    error?: string;
  };
  if (!response.ok || typeof result.text !== "string") {
    throw new TranscribeError(
      result.error ?? "Couldn't transcribe the recording.",
      { status: response.status }
    );
  }
  return result.text;
}

/**
 * The recording's transcript from DZD Learn's speech-to-text.
 * `language` is a Whisper code: "en", "si" or "ta".
 */
export async function transcribeRecording(
  blob: Blob,
  language: string,
  signal?: AbortSignal
) {
  let decoded: { rate: number; samples: Float32Array };
  try {
    decoded = await decodeRecording(blob);
  } catch (error) {
    throw new TranscribeError("Couldn't read the recording.", {
      cause: error,
      status: 0,
    });
  }
  const pieces = speechPieces(resample(decoded.samples, decoded.rate));
  const texts = await Promise.all(
    pieces.map((piece) => transcribePiece(toPcm16(piece), language, signal))
  );
  return texts.join(" ").replace(/\s+/g, " ").trim();
}
