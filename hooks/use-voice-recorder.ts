"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VoiceData } from "@/lib/types";
import {
  alignVoiceWords,
  MAX_VOICE_MS,
  type VoiceEnvelope,
} from "@/lib/voice-message";

/**
 * Voice messages: the browser's built-in speech recognition (free; Chrome,
 * Edge and Safari) writes the transcript while a separate microphone stream
 * is recorded for playback and feeds an analyser so the waveform follows the
 * student's voice. Each word's start time is noted as it is recognised, so
 * playback can highlight the word being spoken.
 *
 * Where the browser can't share the microphone (some Android phones), the
 * recording is dropped and the message is sent as text instead.
 */

export type VoiceLanguage = "en-IN" | "si-LK" | "ta-LK";

export const VOICE_LANGUAGES: readonly {
  id: VoiceLanguage;
  label: string;
  short: string;
}[] = [
  { id: "en-IN", label: "English", short: "EN" },
  { id: "si-LK", label: "සිංහල", short: "සිං" },
  { id: "ta-LK", label: "தமிழ்", short: "தமி" },
];

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

const LANGUAGE_NAMES: Record<VoiceLanguage, string> = {
  "en-IN": "English",
  "si-LK": "Sinhala",
  "ta-LK": "Tamil",
};

function errorMessage(code: string, lang: VoiceLanguage) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings.";
    case "audio-capture":
      return "No microphone was found. Check that one is connected.";
    case "network":
      return "Voice typing needs an internet connection.";
    case "language-not-supported":
      return `${LANGUAGE_NAMES[lang]} voice typing isn't supported in this browser. Try Chrome, or choose another language.`;
    default:
      return "Voice typing stopped unexpectedly. Please try again.";
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

function createRecorder(stream: MediaStream): RecorderState | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
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
const isAndroid = () =>
  typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);

export function useVoiceRecorder({
  lang,
  onFinish,
  onError,
}: {
  lang: VoiceLanguage;
  /** Called when the student stops (the text may be empty). */
  onFinish: (result: VoiceResult) => void;
  onError: (message: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<VoiceState>("idle");
  const [transcript, setTranscript] = useState({ final: "", interim: "" });
  const [startedAt, setStartedAt] = useState(0);

  const stateRef = useRef<VoiceState>("idle");
  const recognitionRef = useRef<Recognition | null>(null);
  // Final text from earlier recognition sessions (it restarts on pauses).
  const committedRef = useRef("");
  const sessionRef = useRef({ final: "", interim: "" });
  const langRef = useRef(lang);
  const onFinishRef = useRef(onFinish);
  const onErrorRef = useRef(onError);
  onFinishRef.current = onFinish;
  onErrorRef.current = onError;

  // Microphone level (analyser), or speech activity as a fallback.
  const audioRef = useRef<{
    stream: MediaStream;
    context: AudioContext;
    analyser: AnalyserNode;
    buffer: Float32Array<ArrayBuffer>;
  } | null>(null);
  const lastSpeechRef = useRef(0);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartTimesRef = useRef<number[]>([]);
  const recorderRef = useRef<RecorderState | null>(null);
  const recordingLostRef = useRef(false);
  // When each transcript word was first heard (performance.now()).
  const heardAtRef = useRef<number[]>([]);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Loudness while recording (performance.now() times), for word timing.
  const envelopeRef = useRef<{ t: number; v: number }[]>([]);
  const envelopeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    setSupported(getRecognitionConstructor() !== null);
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
    await Promise.race([
      recorder.stopped,
      new Promise((resolve) => setTimeout(resolve, FINISH_TIMEOUT_MS)),
    ]);
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

  const startAudio = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (stateRef.current !== "listening") {
        // Stopped or cancelled while the browser was asking for the mic.
        recordingLostRef.current = true;
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      const context = new AudioContext();
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
      try {
        recorderRef.current = createRecorder(stream);
      } catch {
        recorderRef.current = null;
      }
      if (recorderRef.current) {
        const buffer = new Float32Array(analyser.fftSize);
        envelopeRef.current = [];
        envelopeTimerRef.current = setInterval(() => {
          envelopeRef.current.push({
            t: performance.now(),
            v: readLevel(analyser, buffer),
          });
        }, ENVELOPE_MS);
      } else {
        recordingLostRef.current = true;
      }
    } catch {
      // No microphone stream: the waveform follows speech activity and the
      // message is sent as text.
      recordingLostRef.current = true;
    }
  }, []);

  const clearFinishTimer = useCallback(() => {
    if (finishTimerRef.current) {
      clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    clearFinishTimer();
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    stopAudio();
    heardAtRef.current = [];
    envelopeRef.current = [];
    recognitionRef.current = null;
    committedRef.current = "";
    sessionRef.current = { final: "", interim: "" };
    restartTimesRef.current = [];
    setTranscript({ final: "", interim: "" });
    setVoiceState("idle");
  }, [clearFinishTimer, setVoiceState, stopAudio]);

  const deliveringRef = useRef(false);
  const deliver = useCallback(async () => {
    if (deliveringRef.current) {
      return;
    }
    deliveringRef.current = true;
    const text = [
      committedRef.current,
      sessionRef.current.final,
      sessionRef.current.interim,
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const heardAt = heardAtRef.current;
    const envelope = envelopeRef.current;
    const recording = await finishRecording();
    const recordingLost = recordingLostRef.current || !recording;
    reset();
    deliveringRef.current = false;
    onFinishRef.current({
      recordingLost,
      text,
      voice:
        recording && text
          ? {
              blob: recording.blob,
              data: alignVoiceWords(
                text,
                heardAt.map((time) => time - recording.startedAt),
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
  }, [finishRecording, reset]);

  const fail = useCallback(
    (code: string) => {
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
      reset();
      onErrorRef.current(errorMessage(code, langRef.current));
    },
    [reset]
  );

  const startRecognition = useCallback(() => {
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
      const wordCount = [
        committedRef.current,
        sessionRef.current.final,
        sessionRef.current.interim,
      ]
        .join(" ")
        .split(/\s+/)
        .filter(Boolean).length;
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
      if (event.error === "audio-capture" && audioRef.current) {
        // The recording took the microphone: give it back and carry on
        // (the message will be sent as text).
        recordingLostRef.current = true;
        stopAudio();
        return;
      }
      fail(event.error);
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      if (stateRef.current === "finishing") {
        deliver();
        return;
      }
      if (stateRef.current !== "listening") {
        return;
      }
      // Ended on a pause (or language change): keep listening.
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
        fail("restart-loop");
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
  }, [deliver, fail, stopAudio]);

  /** Call directly from a click (Safari needs the user gesture). */
  const start = useCallback(() => {
    if (stateRef.current !== "idle") {
      return;
    }
    committedRef.current = "";
    sessionRef.current = { final: "", interim: "" };
    restartTimesRef.current = [];
    heardAtRef.current = [];
    recordingLostRef.current = false;
    deliveringRef.current = false;
    setTranscript({ final: "", interim: "" });
    setVoiceState("listening");
    if (!startRecognition()) {
      reset();
      onErrorRef.current(errorMessage("start-failed", langRef.current));
      return;
    }
    setStartedAt(performance.now());
    lastSpeechRef.current = 0;
    startAudio();
    // Long recordings are sent automatically at the limit.
    maxTimerRef.current = setTimeout(() => stopRef.current(), MAX_VOICE_MS);
  }, [reset, setVoiceState, startAudio, startRecognition]);

  /** Stop listening and deliver the transcript. */
  const stop = useCallback(() => {
    if (stateRef.current !== "listening") {
      return;
    }
    setVoiceState("finishing");
    if (maxTimerRef.current) {
      clearTimeout(maxTimerRef.current);
      maxTimerRef.current = null;
    }
    // The recording ends now; recognition may need a moment to finish.
    if (envelopeTimerRef.current) {
      clearInterval(envelopeTimerRef.current);
      envelopeTimerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.recorder.state !== "inactive") {
      recorder.recorder.stop();
    }
    const recognition = recognitionRef.current;
    if (!recognition) {
      deliver();
      return;
    }
    recognition.stop();
    // Some browsers never fire "end" after stop().
    finishTimerRef.current = setTimeout(() => {
      if (stateRef.current === "finishing") {
        recognitionRef.current = null;
        recognition.abort();
        deliver();
      }
    }, FINISH_TIMEOUT_MS);
  }, [deliver, setVoiceState]);
  stopRef.current = stop;

  /** Stop listening and throw the transcript away. */
  const cancel = useCallback(() => {
    if (stateRef.current === "idle") {
      return;
    }
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    reset();
  }, [reset]);

  // Language change while listening: restart with the new language.
  useEffect(() => {
    langRef.current = lang;
    if (stateRef.current === "listening") {
      recognitionRef.current?.stop();
    }
  }, [lang]);

  /** Current loudness 0..1 for the waveform (called every frame). */
  const getLevel = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
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
      const recognition = recognitionRef.current;
      recognitionRef.current = null;
      recognition?.abort();
      clearFinishTimer();
      stopAudio();
    },
    [clearFinishTimer, stopAudio]
  );

  return {
    cancel,
    getLevel,
    start,
    startedAt,
    state,
    stop,
    supported,
    transcript,
  };
}
