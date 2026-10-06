"use client";

/**
 * The DZD voice in the browser: streams sentences from /api/voice/speak
 * (raw 16-bit PCM) and plays them gaplessly with the Web Audio API.
 */

const ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/voice/speak`;
const DEFAULT_SAMPLE_RATE = 24_000;

type AudioSessionNavigator = Navigator & {
  audioSession?: { type: string };
};

let context: AudioContext | null = null;

/** The shared audio output (null where Web Audio isn't available). */
export function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }
  if (!context) {
    const Context =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Context) {
      return null;
    }
    context = new Context({ latencyHint: "interactive" });
  }
  return context;
}

/**
 * Unlocks audio playback; call from a tap (iOS and Chrome need one). Also
 * lets iPhones play the voice with the ringer switch on silent.
 */
export function unlockAudio() {
  const ctx = getAudioContext();
  if (!ctx) {
    return;
  }
  const nav = navigator as AudioSessionNavigator;
  if (nav.audioSession) {
    try {
      nav.audioSession.type = "play-and-record";
    } catch {
      // Older Safari: not adjustable.
    }
  }
  ctx.resume().catch(() => undefined);
  // A silent blip, played inside the tap, keeps iOS audio unlocked.
  const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

/**
 * iPhones play audio noticeably quieter while the page is set up to record
 * ("play-and-record"). During a call: "playback" (full volume, still plays
 * with the ringer switch on silent) while the assistant speaks, and
 * "play-and-record" while the student talks. Other devices ignore this.
 */
export function setCallAudio(mode: "listening" | "speaking") {
  const nav =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as AudioSessionNavigator);
  if (!nav?.audioSession) {
    return;
  }
  try {
    nav.audioSession.type =
      mode === "speaking" ? "playback" : "play-and-record";
  } catch {
    // Older Safari: not adjustable.
  }
}

/* ------------------------------------------------------------- loudness */

/**
 * The cloned voice is as quiet as the recording it copies (about -18 dBFS
 * speech level, while phone media is around -14). A compressor evens out
 * loud and soft parts and its automatic make-up gain plus a boost bring
 * the voice up about 5 dB; a soft clipper rounds off the rare peaks so
 * nothing ever distorts. Tuned by rendering the voice sample offline:
 * peak -2.3 -> -0.4 dBFS, speech level -18.1 -> -13.1 dBFS, 0.2% of
 * samples gently rounded.
 */
const LOUDNESS = {
  attack: 0.001,
  boost: 1.8,
  knee: 12,
  ratio: 6,
  release: 0.25,
  threshold: -28,
} as const;
/** The soft clipper is straight up to here, then bends below full scale. */
const SOFT_CLIP_START = 0.8;

function softClipCurve() {
  const size = 4097;
  const curve = new Float32Array(size);
  const room = 1 - SOFT_CLIP_START;
  for (let index = 0; index < size; index += 1) {
    const x = (index / (size - 1)) * 2 - 1;
    const level = Math.abs(x);
    const shaped =
      level <= SOFT_CLIP_START
        ? level
        : SOFT_CLIP_START + room * Math.tanh((level - SOFT_CLIP_START) / room);
    curve[index] = Math.sign(x) * Math.min(shaped, 0.99);
  }
  return curve;
}

let voiceOutput: { context: AudioContext; input: AudioNode } | null = null;

/** Where the assistant's voice is played: louder, never distorted. */
export function getVoiceOutput(ctx: AudioContext): AudioNode {
  if (voiceOutput?.context === ctx) {
    return voiceOutput.input;
  }
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = LOUDNESS.threshold;
  compressor.knee.value = LOUDNESS.knee;
  compressor.ratio.value = LOUDNESS.ratio;
  compressor.attack.value = LOUDNESS.attack;
  compressor.release.value = LOUDNESS.release;
  const boost = ctx.createGain();
  boost.gain.value = LOUDNESS.boost;
  const clipper = ctx.createWaveShaper();
  clipper.curve = softClipCurve();
  // No oversampling: its filter can ring past full scale.
  clipper.oversample = "none";
  compressor.connect(boost).connect(clipper).connect(ctx.destination);
  voiceOutput = { context: ctx, input: compressor };
  return compressor;
}

/** Back to the default audio behaviour once a call ends. */
export function releaseAudioSession() {
  const nav =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as AudioSessionNavigator);
  if (nav?.audioSession) {
    try {
      nav.audioSession.type = "auto";
    } catch {
      // Ignore.
    }
  }
}

/** Whether the DZD voice is ready (also wakes its Space). */
export async function checkVoice(signal?: AbortSignal) {
  try {
    const response = await fetch(ENDPOINT, { cache: "no-store", signal });
    if (!response.ok) {
      return false;
    }
    const health = (await response.json()) as { ok?: boolean };
    return health.ok === true;
  } catch {
    return false;
  }
}

/** Converts little-endian 16-bit PCM to samples, keeping a split byte. */
class PcmDecoder {
  private leftover: number | null = null;

  decode(bytes: Uint8Array) {
    let data = bytes;
    if (this.leftover !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.leftover;
      joined.set(bytes, 1);
      data = joined;
      this.leftover = null;
    }
    const whole = data.length - (data.length % 2);
    if (whole < data.length) {
      this.leftover = data.at(-1) ?? null;
    }
    const view = new DataView(data.buffer, data.byteOffset, whole);
    const samples = new Float32Array(whole / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32_768;
    }
    return samples;
  }
}

/**
 * One sentence of speech, fetched as soon as it's created. Audio arrives
 * in small chunks while the voice is still speaking it.
 */
export class SpeechJob {
  readonly text: string;
  sampleRate = DEFAULT_SAMPLE_RATE;
  readonly chunks: Float32Array[] = [];
  samples = 0;
  done = false;
  failed = false;

  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();

  /** Fails if no audio arrives within `firstAudioTimeoutMs` (if given). */
  constructor(text: string, firstAudioTimeoutMs?: number) {
    this.text = text;
    const timer =
      firstAudioTimeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (this.samples === 0) {
              this.fail();
            }
          }, firstAudioTimeoutMs);
    this.run().finally(() => clearTimeout(timer));
  }

  /** Runs `listener` whenever audio arrives or the job ends. */
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  abort() {
    this.controller.abort();
    this.fail();
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private fail() {
    if (this.done) {
      return;
    }
    this.failed = this.samples === 0;
    this.done = true;
    this.controller.abort();
    this.notify();
  }

  private async run() {
    try {
      const response = await fetch(ENDPOINT, {
        body: JSON.stringify({ text: this.text }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: this.controller.signal,
      });
      if (!(response.ok && response.body)) {
        this.fail();
        return;
      }
      const rate = Number(response.headers.get("x-sample-rate"));
      if (rate > 0) {
        this.sampleRate = rate;
      }
      const reader = response.body.getReader();
      const decoder = new PcmDecoder();
      while (!this.done) {
        // Chunks must be read one after another.
        // biome-ignore lint/performance/noAwaitInLoops: sequential stream reads
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const samples = decoder.decode(value);
        if (samples.length > 0) {
          this.chunks.push(samples);
          this.samples += samples.length;
          this.notify();
        }
      }
      if (!this.done) {
        this.done = true;
        this.failed = this.samples === 0;
        this.notify();
      }
    } catch {
      this.fail();
    }
  }
}

/** Plays a whole clip (a short "mm-hmm"); returns false if it can't. */
export function playClip(buffer: AudioBuffer, volume = 1) {
  const ctx = getAudioContext();
  if (ctx?.state !== "running") {
    return false;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(getVoiceOutput(ctx));
  source.start();
  return true;
}

/** Fetches a short phrase completely, as a playable clip. */
export async function fetchClip(text: string) {
  const ctx = getAudioContext();
  if (!ctx) {
    return null;
  }
  const job = new SpeechJob(text, 8000);
  await new Promise<void>((resolve) => {
    if (job.done) {
      resolve();
      return;
    }
    const unsubscribe = job.subscribe(() => {
      if (job.done) {
        unsubscribe();
        resolve();
      }
    });
  });
  if (job.failed || job.samples === 0) {
    return null;
  }
  const buffer = ctx.createBuffer(1, job.samples, job.sampleRate);
  let offset = 0;
  for (const chunk of job.chunks) {
    buffer.copyToChannel(chunk as Float32Array<ArrayBuffer>, 0, offset);
    offset += chunk.length;
  }
  return buffer;
}
