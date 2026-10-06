"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkVoice,
  fetchClip,
  getAudioContext,
  getVoiceOutput,
  playClip,
  SpeechJob,
  unlockAudio,
} from "@/lib/voice-audio";
import { forSpeech } from "@/lib/voice-pronounce";
import {
  BACKCHANNELS,
  type CallLanguage,
  pickVoice,
  splitSentences,
} from "@/lib/voice-speech";

/**
 * Speaks the assistant's replies in a voice conversation, sentence by
 * sentence as the reply streams in, reporting which word is being said so
 * the transcript can follow along.
 *
 * English uses the DZD voice (streamed from the voice Space through
 * /api/voice/speak); each sentence is fetched as soon as it's written, so
 * the next one is ready when the last ends. If the voice is slow or down,
 * the device's built-in voice (speechSynthesis) takes over, which is also
 * what Sinhala and Tamil use. Where the device has no voice for the
 * language (iPhones have no Sinhala voice) the reply is "read" silently at
 * speaking pace, so the conversation still flows.
 */

export type SpeechProgress = {
  /** The reply being spoken. */
  turnId: string;
  /** Characters of the reply already said (start of the current word). */
  spoken: number;
  /** End of the word being said. */
  wordEnd: number;
  /** End of the sentence being said; text after it isn't shown yet. */
  sentenceEnd: number;
  /** Everything has been said. */
  done: boolean;
};

type Sentence = {
  text: string;
  start: number;
  /** Its audio in the DZD voice. */
  job?: SpeechJob;
  /** Said with the device's voice instead. */
  device?: boolean;
};

type Turn = {
  id: string;
  text: string;
  queued: number;
  sentences: Sentence[];
  complete: boolean;
  finished: boolean;
};

/**
 * Typical speaking pace (in "timing units": one per character, plus a bit
 * for the pause at each comma or full stop), used when the voice doesn't
 * report its words. It is re-measured from every sentence the voice says.
 */
const DEFAULT_PACE: Record<CallLanguage, number> = {
  "en-IN": 15,
  "si-LK": 12,
  "ta-LK": 12,
};
const RATE = 1;

/** The language spoken with the DZD voice. */
const DZD_LANG: CallLanguage = "en-IN";
/** A sentence that hasn't started sounding by then uses the device voice. */
const FIRST_AUDIO_TIMEOUT_MS = 3500;
/** Failed sentences before the call sticks with the device voice. */
const MAX_FAILURES = 2;
/** How long to wait before checking a voice that was down again. */
const RECHECK_MS = 30_000;
/** Audio gathered before a sentence starts, so hiccups don't stutter. */
const START_BUFFER_S = 0.25;
const DZD_PACE_KEY = "dzd-voice";

type VoiceState = "unknown" | "checking" | "ready" | "off";

/** The "mm-hmm"s in the DZD voice, fetched once per page. */
const clipCache = new Map<string, AudioBuffer>();
let clipsLoading = false;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Timing units for each character of a sentence, added up. */
function timingUnits(text: string) {
  const units: number[] = [];
  let total = 0;
  for (const char of text) {
    if (/[,;:]/.test(char)) {
      total += 4;
    } else if (/[.!?…।]/.test(char)) {
      total += 6;
    } else {
      total += 1;
    }
    // One entry per UTF-16 unit, so offsets match string indexes.
    units.push(total);
    if (char.length > 1) {
      units.push(total);
    }
  }
  return units;
}

const hasSynthesis = () =>
  typeof window !== "undefined" && "speechSynthesis" in window;

function wordEndAt(text: string, from: number) {
  const next = text.slice(from).search(/\s/);
  return next === -1 ? text.length : from + next;
}

export function useSpeaker(lang: CallLanguage) {
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  /** null until the device's voices are known. */
  const [hasVoice, setHasVoice] = useState<boolean | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [progress, setProgress] = useState<SpeechProgress | null>(null);
  /** The DZD voice answered its last check. */
  const [voiceReady, setVoiceReady] = useState(false);

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const turnRef = useRef<Turn | null>(null);
  // Bumped to drop events from utterances that were cancelled.
  const tokenRef = useRef(0);
  const busyRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDoneRef = useRef<(() => void) | null>(null);
  // Keeps utterances alive: Chrome drops events of collected ones.
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  /** Measured speaking pace per voice (timing units per second). */
  const paceRef = useRef(new Map<string, number>());
  const langRef = useRef(lang);
  langRef.current = lang;
  const voiceStateRef = useRef<VoiceState>("unknown");
  const lastCheckRef = useRef(0);
  const failuresRef = useRef(0);
  /** Audio playing (or scheduled) for the current reply. */
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  /** When the scheduled audio ends (audio clock). */
  const audioEndRef = useRef(0);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  const setVoiceState = useCallback((state: VoiceState) => {
    voiceStateRef.current = state;
    setVoiceReady(state === "ready");
  }, []);

  /** Whether new sentences should try the DZD voice. */
  const usesDzdVoice = useCallback(
    () =>
      langRef.current === DZD_LANG &&
      voiceStateRef.current !== "off" &&
      getAudioContext() !== null,
    []
  );

  const jobsRunning = useCallback(
    () =>
      turnRef.current?.sentences.some(
        (sentence) => sentence.job && !sentence.job.done
      ) ?? false,
    []
  );

  /**
   * Starts fetching the next sentence's audio. One at a time: the voice
   * makes one sentence at a time, faster than it's said, so the next is
   * ready as the last one ends.
   */
  const fetchAhead = useCallback(
    function fetchNext(turn: Turn) {
      if (
        turn !== turnRef.current ||
        !usesDzdVoice() ||
        turn.sentences.some((item) => item.job && !item.job.done)
      ) {
        return;
      }
      const sentence = turn.sentences
        .slice(turn.queued)
        .find((item) => !(item.job || item.device));
      if (!sentence) {
        return;
      }
      const job = new SpeechJob(sentence.text);
      sentence.job = job;
      const unsubscribe = job.subscribe(() => {
        if (job.done) {
          unsubscribe();
          fetchNext(turn);
        }
      });
    },
    [usesDzdVoice]
  );

  /** Fetches the listening sounds in the DZD voice while it's idle. */
  const loadClips = useCallback(async () => {
    if (clipsLoading) {
      return;
    }
    clipsLoading = true;
    try {
      const phrases = Object.values(BACKCHANNELS[DZD_LANG]).flat();
      for (const phrase of phrases) {
        if (clipCache.has(phrase)) {
          continue;
        }
        // Replies come first; one phrase at a time on the voice's CPU.
        let waited = 0;
        while ((busyRef.current || jobsRunning()) && waited < 120) {
          // biome-ignore lint/performance/noAwaitInLoops: waiting for idle
          await wait(500);
          waited += 1;
        }
        if (!mountedRef.current || voiceStateRef.current !== "ready") {
          return;
        }
        const clip = await fetchClip(phrase);
        if (clip) {
          clipCache.set(phrase, clip);
        }
      }
    } finally {
      clipsLoading = false;
    }
  }, [jobsRunning]);

  /** Checks (and wakes) the DZD voice. */
  const checkDzdVoice = useCallback(async () => {
    if (voiceStateRef.current === "checking") {
      return;
    }
    voiceStateRef.current = "checking";
    lastCheckRef.current = Date.now();
    const ok = await checkVoice();
    if (!mountedRef.current) {
      return;
    }
    setVoiceState(ok ? "ready" : "off");
    if (ok) {
      failuresRef.current = 0;
      loadClips();
    }
  }, [loadClips, setVoiceState]);

  // The device's voices load asynchronously (and change on Chrome).
  useEffect(() => {
    if (!hasSynthesis()) {
      setHasVoice(false);
      return;
    }
    const synth = window.speechSynthesis;
    const update = () => {
      const voices = synth.getVoices();
      if (voices.length === 0) {
        return;
      }
      const chosen = pickVoice(voices, lang);
      voiceRef.current = chosen;
      setVoice(chosen);
      setHasVoice(chosen !== null);
    };
    update();
    synth.addEventListener("voiceschanged", update);
    // Some browsers never fire voiceschanged when there are no voices.
    const timer = setTimeout(() => {
      if (synth.getVoices().length === 0) {
        setHasVoice(false);
      }
    }, 2000);
    return () => {
      synth.removeEventListener("voiceschanged", update);
      clearTimeout(timer);
    };
  }, [lang]);

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) {
      clearTimeout(timer);
    }
    timersRef.current = [];
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  /**
   * Unlocks speech on iOS; call from the tap that opens the call, with the
   * language picked (the hook's own may not have caught up yet).
   */
  const unlock = useCallback(
    (picked: CallLanguage = langRef.current) => {
      if (picked === DZD_LANG) {
        unlockAudio();
        failuresRef.current = 0;
        if (voiceStateRef.current !== "ready") {
          voiceStateRef.current = "unknown";
        }
        checkDzdVoice();
      }
      if (!hasSynthesis()) {
        return;
      }
      const utterance = new SpeechSynthesisUtterance(" ");
      utterance.volume = 0;
      window.speechSynthesis.speak(utterance);
    },
    [checkDzdVoice]
  );

  /** Silences the DZD voice's audio. */
  const stopAudio = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    for (const source of sourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    sourcesRef.current = [];
    audioEndRef.current = 0;
  }, []);

  const finishIfDone = useCallback(() => {
    const turn = turnRef.current;
    if (!turn || turn.finished || busyRef.current) {
      return;
    }
    if (turn.complete && turn.queued >= turn.sentences.length) {
      turn.finished = true;
      setSpeaking(false);
      setProgress({
        done: true,
        sentenceEnd: turn.text.length,
        spoken: turn.text.length,
        turnId: turn.id,
        wordEnd: turn.text.length,
      });
      const onDone = onDoneRef.current;
      onDoneRef.current = null;
      onDone?.();
    }
  }, []);

  const speakNext = useCallback(() => {
    const turn = turnRef.current;
    if (!turn || busyRef.current || turn.queued >= turn.sentences.length) {
      finishIfDone();
      return;
    }
    const sentence = turn.sentences[turn.queued];
    turn.queued += 1;
    busyRef.current = true;
    tokenRef.current += 1;
    const token = tokenRef.current;
    const sentenceEnd = sentence.start + sentence.text.length;
    const lastWordStart = Math.max(
      sentence.start,
      turn.text.lastIndexOf(" ", sentenceEnd - 1) + 1
    );
    const units = timingUnits(sentence.text);
    const totalUnits = units.at(-1) ?? 1;
    const synth = hasSynthesis() ? window.speechSynthesis : null;
    const voiceNow = voiceRef.current;
    const paceKey = voiceNow ? voiceNow.voiceURI || voiceNow.name : "";
    const pace = () =>
      (paceRef.current.get(paceKey) ?? DEFAULT_PACE[langRef.current]) * RATE;
    // Until the audio really starts (network voices take a moment).
    let startedAt = performance.now();
    let heardWord = false;

    const show = (offset: number) => {
      const at = Math.min(Math.max(offset, sentence.start), sentenceEnd);
      setProgress({
        done: false,
        sentenceEnd,
        spoken: at,
        turnId: turn.id,
        wordEnd: wordEndAt(turn.text, at),
      });
    };
    const next = () => {
      if (token !== tokenRef.current) {
        return;
      }
      clearTimers();
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      busyRef.current = false;
      show(sentenceEnd);
      speakNext();
    };

    const ctx = getAudioContext();
    if (!(sentence.job || sentence.device) && usesDzdVoice()) {
      sentence.job = new SpeechJob(sentence.text);
    }
    const { job } = sentence;
    if (job && !job.failed && ctx?.state === "running") {
      /** Plays the sentence in the DZD voice as its audio streams in. */
      let started = false;
      let startAt = 0;
      let endAt = 0;
      let scheduled = 0;
      let startedPerf = 0;
      const switchToDevice = () => {
        clearTimers();
        unsubscribeRef.current?.();
        unsubscribeRef.current = null;
        failuresRef.current += 1;
        if (failuresRef.current >= MAX_FAILURES) {
          setVoiceState("off");
        }
        job.abort();
        sentence.job = undefined;
        sentence.device = true;
        turn.queued -= 1;
        busyRef.current = false;
        speakNext();
      };
      const schedule = () => {
        if (token !== tokenRef.current) {
          return;
        }
        if (!started) {
          if (job.failed) {
            switchToDevice();
            return;
          }
          const buffered = job.samples / job.sampleRate;
          if (!job.done && buffered < START_BUFFER_S) {
            return;
          }
          ctx.resume().catch(() => undefined);
          started = true;
          startedPerf = performance.now();
          failuresRef.current = 0;
          startAt = Math.max(ctx.currentTime + 0.03, audioEndRef.current);
          endAt = startAt;
          setSpeaking(true);
          show(sentence.start);
        }
        while (scheduled < job.chunks.length) {
          const data = job.chunks[scheduled];
          scheduled += 1;
          const buffer = ctx.createBuffer(1, data.length, job.sampleRate);
          buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(getVoiceOutput(ctx));
          // Ran dry (slow network): carry on straight away.
          endAt = Math.max(endAt, ctx.currentTime + 0.02);
          source.start(endAt);
          sourcesRef.current.push(source);
          endAt += buffer.duration;
        }
        audioEndRef.current = endAt;
      };
      unsubscribeRef.current = job.subscribe(schedule);
      schedule();
      // Too slow to start: say this sentence with the device's voice.
      timersRef.current.push(
        setTimeout(() => {
          if (!started) {
            job.abort();
          }
        }, FIRST_AUDIO_TIMEOUT_MS)
      );
      tickRef.current = setInterval(() => {
        if (token !== tokenRef.current || !started) {
          return;
        }
        const now = ctx.currentTime;
        // The audio clock stalls if the output is interrupted (a phone call).
        const stalled =
          performance.now() - startedPerf > (endAt - startAt) * 1000 + 3000;
        if (
          job.done &&
          scheduled >= job.chunks.length &&
          (now >= endAt - 0.03 || stalled)
        ) {
          const seconds = job.samples / job.sampleRate;
          if (seconds > 0.4 && totalUnits > 8) {
            const measured = totalUnits / seconds;
            const previous = paceRef.current.get(DZD_PACE_KEY) ?? measured;
            paceRef.current.set(
              DZD_PACE_KEY,
              Math.min(30, Math.max(6, previous * 0.4 + measured * 0.6))
            );
          }
          sourcesRef.current = [];
          next();
          return;
        }
        // Follow along by time; exact once all the audio has arrived.
        const total = job.done
          ? job.samples / job.sampleRate
          : totalUnits /
            (paceRef.current.get(DZD_PACE_KEY) ?? DEFAULT_PACE[DZD_LANG]);
        const reached = ((now - startAt) / Math.max(total, 0.1)) * totalUnits;
        let index = units.findIndex((unit) => unit >= reached);
        if (index === -1) {
          index = sentence.text.length - 1;
        }
        const offset = sentence.start + index;
        const before = turn.text.lastIndexOf(" ", offset) + 1;
        show(Math.min(Math.max(before, sentence.start), lastWordStart));
      }, 50);
      return;
    }

    setSpeaking(true);
    show(sentence.start);
    // Follow along by time until (unless) the voice reports its words.
    tickRef.current = setInterval(() => {
      if (token !== tokenRef.current || heardWord) {
        return;
      }
      const elapsed = (performance.now() - startedAt) / 1000;
      const reached = elapsed * pace();
      let index = units.findIndex((unit) => unit >= reached);
      if (index === -1) {
        index = sentence.text.length - 1;
      }
      // Stay on the word the estimate is in (at most the last word).
      const offset = sentence.start + index;
      const before = turn.text.lastIndexOf(" ", offset) + 1;
      show(Math.min(Math.max(before, sentence.start), lastWordStart));
    }, 80);

    const expectedMs = (totalUnits / pace()) * 1000;
    if (!(synth && voiceNow)) {
      // No voice: "read" at speaking pace.
      timersRef.current.push(setTimeout(next, expectedMs + 250));
      return;
    }
    // English in plain words (A/L -> A Level); word positions then no
    // longer match the transcript, so it follows along by time instead.
    const said =
      langRef.current === DZD_LANG ? forSpeech(sentence.text) : sentence.text;
    const utterance = new SpeechSynthesisUtterance(said);
    utterance.voice = voiceNow;
    utterance.lang = voiceNow.lang;
    utterance.rate = RATE;
    utterance.pitch = 1;
    utterance.onstart = () => {
      if (token === tokenRef.current) {
        startedAt = performance.now();
      }
    };
    utterance.onboundary = (event) => {
      if (
        token !== tokenRef.current ||
        event.name !== "word" ||
        said !== sentence.text
      ) {
        return;
      }
      heardWord = true;
      show(sentence.start + event.charIndex);
    };
    utterance.onend = () => {
      if (token === tokenRef.current) {
        // Learn this voice's real pace for the next sentence.
        const seconds = (performance.now() - startedAt) / 1000;
        if (seconds > 0.4 && totalUnits > 8) {
          const measured = totalUnits / seconds / RATE;
          const previous = paceRef.current.get(paceKey) ?? measured;
          paceRef.current.set(
            paceKey,
            Math.min(30, Math.max(6, previous * 0.4 + measured * 0.6))
          );
        }
      }
      next();
    };
    utterance.onerror = next;
    utteranceRef.current = utterance;
    synth.speak(utterance);
    // Safety net: some browsers occasionally never fire "end".
    timersRef.current.push(setTimeout(next, expectedMs * 2.5 + 4000));
  }, [clearTimers, finishIfDone, setVoiceState, usesDzdVoice]);

  /**
   * The reply so far (speakable text). New complete sentences are queued;
   * with `complete` the rest is too, and `onDone` runs once it's all said.
   */
  const feed = useCallback(
    (turnId: string, text: string, complete: boolean, onDone?: () => void) => {
      let turn = turnRef.current;
      if (!turn || turn.id !== turnId) {
        for (const old of turn?.sentences ?? []) {
          old.job?.abort();
        }
        if (
          langRef.current === DZD_LANG &&
          voiceStateRef.current === "off" &&
          Date.now() - lastCheckRef.current > RECHECK_MS
        ) {
          checkDzdVoice();
        }
        turn = {
          complete: false,
          finished: false,
          id: turnId,
          queued: 0,
          sentences: [],
          text,
        };
        turnRef.current = turn;
      }
      if (turn.finished) {
        return;
      }
      turn.text = text;
      turn.complete = complete;
      if (onDone) {
        onDoneRef.current = onDone;
      }
      // Sentences already queued stay; the text after them is split anew.
      const last = turn.sentences.at(-1);
      let searchFrom = last ? last.start + last.text.length : 0;
      for (const sentence of splitSentences(text.slice(searchFrom), complete)) {
        const start = text.indexOf(sentence, searchFrom);
        const at = start === -1 ? searchFrom : start;
        turn.sentences.push({ start: at, text: sentence });
        searchFrom = at + sentence.length;
      }
      fetchAhead(turn);
      if (busyRef.current) {
        return;
      }
      speakNext();
    },
    [checkDzdVoice, fetchAhead, speakNext]
  );

  /** Stops speaking at once (interrupt, end of call). */
  const cancel = useCallback(() => {
    tokenRef.current += 1;
    clearTimers();
    stopAudio();
    for (const sentence of turnRef.current?.sentences ?? []) {
      sentence.job?.abort();
    }
    busyRef.current = false;
    turnRef.current = null;
    onDoneRef.current = null;
    utteranceRef.current = null;
    setSpeaking(false);
    setProgress(null);
    if (hasSynthesis()) {
      window.speechSynthesis.cancel();
    }
  }, [clearTimers, stopAudio]);

  /** A soft "mm-hmm" while the student pauses. False if it can't play. */
  const backchannel = useCallback((phrase: string) => {
    if (langRef.current === DZD_LANG && voiceStateRef.current === "ready") {
      // Only in the DZD voice: a different voice saying "mm-hmm" is odd.
      const clip = clipCache.get(phrase);
      return Boolean(clip && !busyRef.current && playClip(clip, 0.7));
    }
    const voiceNow = voiceRef.current;
    if (!(hasSynthesis() && voiceNow) || busyRef.current) {
      return false;
    }
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.voice = voiceNow;
    utterance.lang = voiceNow.lang;
    // Softer and a touch quicker than speech, like a murmur.
    utterance.rate = 1.08;
    utterance.volume = 0.6;
    window.speechSynthesis.speak(utterance);
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      tokenRef.current += 1;
      clearTimers();
      stopAudio();
      for (const sentence of turnRef.current?.sentences ?? []) {
        sentence.job?.abort();
      }
      if (hasSynthesis()) {
        window.speechSynthesis.cancel();
      }
    };
  }, [clearTimers, stopAudio]);

  return {
    backchannel,
    cancel,
    feed,
    // The DZD voice speaks English even where the device has no voice.
    hasVoice: lang === DZD_LANG && voiceReady ? true : hasVoice,
    progress,
    speaking,
    unlock,
    voice,
  };
}
