"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceData } from "@/lib/types";
import {
  alignVoiceWords,
  MAX_VOICE_MS,
  type VoiceEnvelope,
} from "@/lib/voice-message";
import { TranscribeError, transcribeRecording } from "@/lib/voice-transcribe";

/**
 * Voice messages. The student picks the language first, then the
 * microphone is recorded (for playback, and feeding an analyser so the
 * waveform follows their voice). When they stop, the recording is turned
 * into text by DZD Learn's own speech-to-text on the server (Whisper, see
 * lib/voice-transcribe.ts), so it works the same on every phone and browser.
 *
 * On computers the browser's built-in recognition also runs, only to show
 * live captions while speaking (and as a fallback if the server can't be
 * reached). Phones skip it: on many Android devices it can't share the
 * microphone with the recording and silently hears nothing.
 */

export type VoiceLanguage = "en-IN" | "si-LK" | "ta-LK";

export const VOICE_LANGUAGES: readonly {
  id: VoiceLanguage;
  label: string;
  /** English name, for screen readers and messages. */
  name: string;
  short: string;
  /** Language code for the speech-to-text server (Whisper). */
  speech: "en" | "si" | "ta";
}[] = [
  { id: "en-IN", label: "English", name: "English", short: "EN", speech: "en" },
  { id: "si-LK", label: "සිංහල", name: "Sinhala", short: "සිං", speech: "si" },
  { id: "ta-LK", label: "தமிழ்", name: "Tamil", short: "தமி", speech: "ta" },
];

export const voiceLanguageInfo = (lang: VoiceLanguage) =>
  VOICE_LANGUAGES.find((option) => option.id === lang) ?? VOICE_LANGUAGES[0];

/** "finishing": stopped, turning the recording into text. */
export type VoiceState = "idle" | "listening" | "finishing";

/* Minimal Web Speech API types (not in TypeScript's DOM library). */
type RecognitionAlternative = { transcript: string };
type RecognitionResult = {
  isFinal: boolean;
  length: number;
  [index: number]: RecognitionAlternative;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
};
type RecognitionErrorEvent = { error: string };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionConstructor = new () => Recognition;

function getRecognitionConstructor(): RecognitionConstructor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

const canRecord = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.mediaDevices?.getUserMedia === "function" &&
  typeof MediaRecorder !== "undefined";

const isAndroid = () =>
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

/** Phones and tablets (iPadOS reports itself as a Mac with touch). */
const isMobileDevice = () =>
  typeof navigator !== "undefined" &&
  (/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

function errorMessage(code: string, lang: VoiceLanguage) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings.";
    case "audio-capture":
      return "No microphone was found. Check that one is connected.";
    case "network":
      return "Voice messages need an internet connection.";
    case "language-not-supported":
      return `${voiceLanguageInfo(lang).name} voice typing isn't supported in this browser. Try Chrome, or choose another language.`;
    case "unsupported":
      return "This browser can't record audio. Try updating it, or use Chrome or Safari.";
    default:
      return "Voice recording stopped unexpectedly. Please try again.";
  }
}

/** Level 0..1 from an analyser (dB scale, so quiet speech still shows). */
function readLevel(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / buffer.length);
  const db = 20 * Math.log10(rms || 1e-8);
  return Math.min(1, Math.max(0, (db + 58) / 46));
}

const FINISH_TIMEOUT_MS = 1800;
/** How often the loudness is sampled for word timing. */
const ENVELOPE_MS = 20;
const RECORDER_TYPES = [
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/webm",
];

export type VoiceResult = {
  text: string;
  /** The recording, when the browser could record it. */
  voice?: { blob: Blob; mimeType: string; data: VoiceData };
  /** Recording failed or wasn't possible, so only the text is available. */
  recordingLost: boolean;
};

type RecorderState = {
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  stoppedAt: number;
  stopped: Promise<void>;
};

function createRecorder(stream: MediaStream): RecorderState {
  const mimeType =
    RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  const recorder = new MediaRecorder(stream, {
    audioBitsPerSecond: 32_000,
    ...(mimeType ? { mimeType } : {}),
  });
  const state: RecorderState = {
    chunks: [],
    mimeType: mimeType || recorder.mimeType,
    recorder,
    startedAt: performance.now(),
    stopped: Promise.resolve(),
    stoppedAt: 0,
  };
  state.stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      state.stoppedAt = performance.now();
      resolve();
    };
  });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      state.chunks.push(event.data);
    }
  };
  recorder.start(1000);
  state.startedAt = performance.now();
  return state;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function useVoiceRecorder({
  onFinish,
  onError,
}: {
  /** Called when the student stops (the text may be empty). */
  onFinish: (result: VoiceResult) => void;
  onError: (message: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState({ final: "", interim: "" });
  const [startedAt, setStartedAt] = useState(0);
  const [lang, setLang] = useState<VoiceLanguage>("en-IN");

  const stateRef = useRef<VoiceState>("idle");
  // Each recording gets a new id, so late results of a cancelled one are
  // ignored.
  const sessionIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const langRef = useRef<VoiceLanguage>("en-IN");
  const onFinishRef = useRef(onFinish);
  const onErrorRef = useRef(onError);
  onFinishRef.current = onFinish;
  onErrorRef.current = onError;

  // Live captions (browser recognition; computers only).
  const recognitionRef = useRef<Recognition | null>(null);
  const recognitionEndedRef = useRef<(() => void) | null>(null);
  // Final text from earlier recognition sessions (it restarts on pauses).
  const committedRef = useRef("");
  const sessionRef = useRef({ final: "", interim: "" });
  const restartTimesRef = useRef<number[]>([]);
  const heardAtRef = useRef<number[]>([]);
  /** No recording is possible: the captions are the message. */
  const captionsOnlyRef = useRef(false);

  // Microphone: level (analyser) and the recording.
  const audioRef = useRef<{
    stream: MediaStream;
    context: AudioContext;
    analyser: AnalyserNode;
    buffer: Float32Array<ArrayBuffer>;
  } | null>(null);
  const lastSpeechRef = useRef(0);
  const recorderRef = useRef<RecorderState | null>(null);
  const recordingLostRef = useRef(false);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Loudness while recording (performance.now() times), for word timing.
  const envelopeRef = useRef<{ t: number; v: number }[]>([]);
  const envelopeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    setSupported(canRecord() || getRecognitionConstructor() !== null);
  }, []);

  const setVoiceState = useCallback((next: VoiceState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /** Releases the microphone; an unfinished recording is thrown away. */
  const stopAudio = useCallback(() => {
    if (envelopeTimerRef.current) {
      clearInterval(envelopeTimerRef.current);
      envelopeTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.recorder.state !== "inactive") {
      recorder.recorder.stop();
    }
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      for (const track of audio.stream.getTracks()) {
        track.stop();
      }
      audio.context.close().catch(() => undefined);
    }
  }, []);

  const stopRecognition = useCallback((abort: boolean) => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      if (abort) {
        recognition.abort();
      } else {
        recognition.stop();
      }
    }
    recognitionEndedRef.current?.();
    recognitionEndedRef.current = null;
  }, []);

  const reset = useCallback(() => {
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    stopRecognition(true);
    stopAudio();
    heardAtRef.current = [];
    envelopeRef.current = [];
    committedRef.current = "";
    sessionRef.current = { final: "", interim: "" };
    restartTimesRef.current = [];
    captionsOnlyRef.current = false;
    setTranscript({ final: "", interim: "" });
    setVoiceState("idle");
  }, [setVoiceState, stopAudio, stopRecognition]);

  const fail = useCallback(
    (code: string) => {
      sessionIdRef.current += 1;
      reset();
      onErrorRef.current(errorMessage(code, langRef.current));
    },
    [reset]
  );

  const captionText = useCallback(
    () =>
      [
        committedRef.current,
        sessionRef.current.final,
        sessionRef.current.interim,
      ]
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    []
  );

  /** Finishes the recording and returns it (null if there is none). */
  const finishRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (!recorder) {
      stopAudio();
      return null;
    }
    if (recorder.recorder.state !== "inactive") {
      recorder.recorder.stop();
    }
    await Promise.race([recorder.stopped, wait(FINISH_TIMEOUT_MS)]);
    stopAudio();
    if (recorder.chunks.length === 0) {
      return null;
    }
    const blob = new Blob(recorder.chunks, {
      type: recorder.mimeType || recorder.chunks[0].type,
    });
    return {
      blob,
      duration: (recorder.stoppedAt || performance.now()) - recorder.startedAt,
      mimeType: blob.type,
      startedAt: recorder.startedAt,
    };
  }, [stopAudio]);

  /** Stops everything, transcribes the recording and hands over the text. */
  const deliver = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const language = voiceLanguageInfo(langRef.current);

    // Let live captions settle (they're the fallback), then end the
    // recording.
    const recognition = recognitionRef.current;
    const captionsDone = recognition
      ? new Promise<void>((resolve) => {
          recognitionEndedRef.current = resolve;
          recognition.stop();
        })
      : Promise.resolve();
    const [recording] = await Promise.all([
      finishRecording(),
      Promise.race([captionsDone, wait(FINISH_TIMEOUT_MS)]),
    ]);
    stopRecognition(true);
    if (sessionId !== sessionIdRef.current) {
      return; // cancelled meanwhile
    }
    const captions = captionText();
    const heardAt = heardAtRef.current;
    const envelope = envelopeRef.current;

    let text = captions;
    let usedCaptions = true;
    if (recording) {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        text = await transcribeRecording(
          recording.blob,
          language.speech,
          controller.signal
        );
        usedCaptions = false;
        abortRef.current = null;
      } catch (error) {
        if (sessionId !== sessionIdRef.current) {
          return;
        }
        console.warn("Voice transcription failed:", error);
        if (!captions) {
          reset();
          onErrorRef.current(
            error instanceof TranscribeError && error.status > 0
              ? error.message.includes("try again")
                ? error.message
                : `${error.message} Please try again.`
              : "Couldn't turn your voice into text. Check your connection and try again."
          );
          return;
        }
      }
    }
    if (sessionId !== sessionIdRef.current) {
      return;
    }
    const recordingLost = recordingLostRef.current || !recording;
    reset();
    onFinishRef.current({
      recordingLost,
      text,
      voice:
        recording && text
          ? {
              blob: recording.blob,
              data: alignVoiceWords(
                text,
                // Caption timings only fit the caption words.
                usedCaptions
                  ? heardAt.map((time) => time - recording.startedAt)
                  : [],
                envelope.map((sample): VoiceEnvelope[number] => ({
                  t: sample.t - recording.startedAt,
                  v: sample.v,
                })),
                recording.duration
              ),
              mimeType: recording.mimeType,
            }
          : undefined,
    });
  }, [captionText, finishRecording, reset, stopRecognition]);

  const startRecognition = useCallback((): boolean => {
    const Constructor = getRecognitionConstructor();
    if (!Constructor) {
      return false;
    }
    const recognition = new Constructor();
    recognition.lang = langRef.current;
    // Android Chrome repeats results in continuous mode; there it listens
    // per phrase and restarts after each pause instead.
    recognition.continuous = !isAndroid();
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onspeechstart = () => {
      lastSpeechRef.current = performance.now();
    };
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      lastSpeechRef.current = performance.now();
      let final = "";
      let interim = "";
      for (const result of Array.from(event.results)) {
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }
      sessionRef.current = { final: final.trim(), interim: interim.trim() };
      // Note when each new word was first heard (for playback highlighting).
      const wordCount = captionText().split(/\s+/).filter(Boolean).length;
      const now = performance.now();
      while (heardAtRef.current.length < wordCount) {
        heardAtRef.current.push(now);
      }
      setTranscript({
        final: [committedRef.current, sessionRef.current.final]
          .filter(Boolean)
          .join(" "),
        interim: sessionRef.current.interim,
      });
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // onend restarts or finishes
      }
      if (captionsOnlyRef.current) {
        fail(event.error);
        return;
      }
      // Captions are optional: the recording carries on without them.
      recognitionRef.current = null;
      recognition.abort();
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      if (stateRef.current !== "listening") {
        recognitionEndedRef.current?.();
        recognitionEndedRef.current = null;
        return;
      }
      // Ended on a pause: keep listening.
      committedRef.current = [committedRef.current, sessionRef.current.final]
        .filter(Boolean)
        .join(" ");
      sessionRef.current = { final: "", interim: "" };
      const now = Date.now();
      restartTimesRef.current = [
        ...restartTimesRef.current.filter((time) => now - time < 3000),
        now,
      ];
      if (restartTimesRef.current.length > 6) {
        if (captionsOnlyRef.current) {
          fail("restart-loop");
        } else {
          recognitionRef.current = null;
        }
        return;
      }
      startRecognition();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      return true;
    } catch {
      recognitionRef.current = null;
      return false;
    }
  }, [captionText, fail]);

  /** Without a recording, browser recognition is the only way to listen. */
  const fallBackToCaptions = useCallback(
    (code: string) => {
      recordingLostRef.current = true;
      captionsOnlyRef.current = true;
      if (!(recognitionRef.current || startRecognition())) {
        fail(code);
      }
    },
    [fail, startRecognition]
  );

  const startAudio = useCallback(
    async (sessionId: number) => {
      if (!canRecord()) {
        fallBackToCaptions("unsupported");
        return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
          },
        });
      } catch (error) {
        if (sessionId !== sessionIdRef.current) {
          return;
        }
        const { name } = error as { name?: string };
        if (name === "NotAllowedError" || name === "SecurityError") {
          fail("not-allowed");
        } else if (
          name === "NotFoundError" ||
          name === "OverconstrainedError"
        ) {
          fail("audio-capture");
        } else {
          fallBackToCaptions("start-failed");
        }
        return;
      }
      if (
        sessionId !== sessionIdRef.current ||
        stateRef.current !== "listening"
      ) {
        // Stopped or cancelled while the browser was asking for the mic.
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      try {
        recorderRef.current = createRecorder(stream);
      } catch {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        fallBackToCaptions("unsupported");
        return;
      }
      // The waveform and word timing; the recording works without them.
      try {
        const Context =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext })
            .webkitAudioContext;
        const context = new Context();
        await context.resume().catch(() => undefined);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        analyser.smoothingTimeConstant = 0.5;
        context.createMediaStreamSource(stream).connect(analyser);
        audioRef.current = {
          analyser,
          buffer: new Float32Array(analyser.fftSize),
          context,
          stream,
        };
        const buffer = new Float32Array(analyser.fftSize);
        envelopeRef.current = [];
        envelopeTimerRef.current = setInterval(() => {
          envelopeRef.current.push({
            t: performance.now(),
            v: readLevel(analyser, buffer),
          });
        }, ENVELOPE_MS);
      } catch {
        audioRef.current = null;
      }
      if (!audioRef.current) {
        // Still release the microphone when the recording ends.
        const recorder = recorderRef.current;
        recorder?.stopped.then(() => {
          for (const track of stream.getTracks()) {
            track.stop();
          }
        });
      }
    },
    [fail, fallBackToCaptions]
  );

  /**
   * Starts recording in the chosen language. Call directly from a click
   * (Safari needs the user gesture for the microphone and audio).
   */
  const start = useCallback(
    (language: VoiceLanguage) => {
      if (stateRef.current !== "idle") {
        return;
      }
      sessionIdRef.current += 1;
      const sessionId = sessionIdRef.current;
      langRef.current = language;
      setLang(language);
      committedRef.current = "";
      sessionRef.current = { final: "", interim: "" };
      restartTimesRef.current = [];
      heardAtRef.current = [];
      envelopeRef.current = [];
      recordingLostRef.current = false;
      captionsOnlyRef.current = false;
      lastSpeechRef.current = 0;
      setTranscript({ final: "", interim: "" });
      setVoiceState("listening");
      setStartedAt(performance.now());
      // Live captions on computers only (see the note at the top).
      if (!isMobileDevice()) {
        startRecognition();
      }
      startAudio(sessionId);
      // Long recordings are sent automatically at the limit.
      maxTimerRef.current = setTimeout(() => stopRef.current(), MAX_VOICE_MS);
    },
    [setVoiceState, startAudio, startRecognition]
  );

  /** Stop recording and send it to be transcribed. */
  const stop = useCallback(() => {
    if (stateRef.current !== "listening") {
      return;
    }
    setVoiceState("finishing");
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    // The recording ends now.
    if (envelopeTimerRef.current) {
      clearInterval(envelopeTimerRef.current);
      envelopeTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.recorder.state !== "inactive") {
      recorder.recorder.stop();
    }
    deliver();
  }, [deliver, setVoiceState]);
  stopRef.current = stop;

  /** Stop and throw the recording away (also while transcribing). */
  const cancel = useCallback(() => {
    if (stateRef.current === "idle") {
      return;
    }
    sessionIdRef.current += 1;
    reset();
  }, [reset]);

  /** Current loudness 0..1 for the waveform (called every frame). */
  const getLevel = useCallback(() => {
    const audio = audioRef.current;
    if (audio && stateRef.current === "listening") {
      return readLevel(audio.analyser, audio.buffer);
    }
    if (stateRef.current !== "listening") {
      return 0;
    }
    // Fallback: lively while words are arriving, calm otherwise.
    const sinceSpeech = performance.now() - lastSpeechRef.current;
    const active = lastSpeechRef.current > 0 && sinceSpeech < 700;
    return active ? 0.3 + Math.random() * 0.55 : 0.04 + Math.random() * 0.06;
  }, []);

  // Clean up if the composer unmounts mid-recording.
  useEffect(
    () => () => {
      sessionIdRef.current += 1;
      abortRef.current?.abort();
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
      }
      stopAudio();
    },
    [stopAudio]
  );

  return {
    cancel,
    getLevel,
    /** The language of the current (or last) recording. */
    lang,
    start,
    startedAt,
    state,
    stop,
    supported,
    transcript,
  };
}
