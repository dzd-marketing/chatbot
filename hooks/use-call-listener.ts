"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getRecognitionConstructor,
  isAndroid,
  type Recognition,
} from "@/hooks/use-voice-recorder";
import {
  type BackchannelKind,
  type CallLanguage,
  endsWithFiller,
  type PlayedBackchannel,
  removeBackchannelEchoes,
  soundsLikeQuestion,
  soundsUnfinished,
} from "@/lib/voice-speech";

/**
 * Listens to the student in a voice conversation with the browser's speech
 * recognition, like the voice messages do.
 *
 * Turn-taking works like a phone call:
 * - The turn ends after a short silence, sooner when the student has asked
 *   a question or given a short answer, later when they trail off mid-
 *   sentence ("…and", "…because", "umm") so slow speakers aren't cut off.
 * - On pauses mid-thought the assistant makes soft listening sounds:
 *   "mm-hmm" to say go on, "okay" / "I see" after a longer point, and "take
 *   your time" when the student hesitates. Not on every pause, not right
 *   after the last one, and never after a question.
 */

/** Silence that ends the student's turn, by how the speech sounds. */
const END_OF_TURN_MS = {
  /** The recogniser has finished the sentence. */
  finished: 950,
  normal: 1150,
  /** A question: they're waiting for the answer. */
  question: 750,
  /** "Yes", "okay, go on": quick replies get quick answers. */
  short: 850,
  /** Trailing off ("…and", "umm"): they're still thinking. */
  unfinished: 2300,
} as const;
/** A listening sound just played: the student is probably carrying on. */
const AFTER_BACKCHANNEL_MS = 400;
/** Shortest pause that gets a listening sound. */
const BACKCHANNEL_MIN_PAUSE_MS = 420;
/** Hesitation ("umm…"): wait a little longer before encouraging. */
const ENCOURAGE_PAUSE_MS = 900;
/** Encouraging a hesitating student may come sooner after another sound. */
const ENCOURAGE_GAP_MS = 2000;
/** Words before the first listening sound of a turn, and between sounds. */
const BACKCHANNEL_FIRST_WORDS = 4;
const BACKCHANNEL_GAP_WORDS = 5;
/** After this many words since the last sound, acknowledge the point. */
const ACKNOWLEDGE_WORDS = 12;
/** Time between listening sounds (varied, so it doesn't feel mechanical). */
const BACKCHANNEL_GAP_MS: readonly [number, number] = [3500, 5500];
/** Not every pause gets a sound, like a person listening. */
const CONTINUE_CHANCE = 0.7;
/** Recognition stopping right after our sound (iOS): give up the sounds. */
const BACKCHANNEL_CLASH_MS = 1200;
const BACKCHANNEL_MAX_CLASHES = 2;
/** Nobody has spoken for this long: the call goes to sleep (mic off). */
const SLEEP_AFTER_MS = 90_000;

const randomGap = () =>
  BACKCHANNEL_GAP_MS[0] +
  Math.random() * (BACKCHANNEL_GAP_MS[1] - BACKCHANNEL_GAP_MS[0]);

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function useCallListener({
  lang,
  onTurn,
  onBackchannel,
  onError,
  onSleep,
}: {
  lang: CallLanguage;
  /** The student finished speaking. */
  onTurn: (text: string) => void;
  /** Play a listening sound of this kind now; the phrase, or null. */
  onBackchannel: (kind: BackchannelKind) => string | null;
  onError: (message: string) => void;
  /** Long silence: the call should go to sleep. */
  onSleep: () => void;
}) {
  const [listening, setListening] = useState(false);
  /** What the student is saying, live. */
  const [live, setLive] = useState("");

  const activeRef = useRef(false);
  const recognitionRef = useRef<Recognition | null>(null);
  // Final text from earlier recognition sessions (Android restarts often).
  const committedRef = useRef("");
  const sessionRef = useRef({ final: "", interim: "" });
  const lastResultAtRef = useRef(0);
  const startedAtRef = useRef(0);
  const restartTimesRef = useRef<number[]>([]);
  const backchannelRef = useRef({
    /** When the last sound played (performance.now()). */
    at: 0,
    encouraged: false,
    /** "Mm-hmm" (go on) rather than "okay": the student will carry on. */
    expectMore: false,
    gapMs: 0,
    /** The pause that already got a sound (its lastResultAt). */
    pause: -1,
    played: [] as PlayedBackchannel[],
    words: 0,
  });
  // Sounds stop recognition on some phones: count it, then stop the sounds.
  const clashesRef = useRef(0);
  const lastFinalRef = useRef(false);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;
  const callbacksRef = useRef({ onBackchannel, onError, onSleep, onTurn });
  callbacksRef.current = { onBackchannel, onError, onSleep, onTurn };

  const fullText = useCallback(
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

  const halt = useCallback(() => {
    activeRef.current = false;
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    recognition?.abort();
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setListening(false);
  }, []);

  const fail = useCallback(
    (code: string) => {
      halt();
      setLive("");
      callbacksRef.current.onError(errorMessage(code, langRef.current));
    },
    [halt]
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
      lastResultAtRef.current = performance.now();
    };
    recognition.onresult = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      lastResultAtRef.current = performance.now();
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
      lastFinalRef.current = final.trim() !== "" && interim.trim() === "";
      setLive(fullText());
    };
    recognition.onerror = (event) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      if (event.error === "no-speech" || event.error === "aborted") {
        return; // onend restarts
      }
      fail(event.error);
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition || !activeRef.current) {
        return;
      }
      const sinceBackchannel = performance.now() - backchannelRef.current.at;
      if (
        backchannelRef.current.at > 0 &&
        sinceBackchannel < BACKCHANNEL_CLASH_MS
      ) {
        clashesRef.current += 1;
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
        fail("restart-loop");
        return;
      }
      if (!startRecognition()) {
        fail("start-failed");
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
      return true;
    } catch {
      recognitionRef.current = null;
      return false;
    }
  }, [fail, fullText]);

  const resetBackchannels = useCallback(() => {
    backchannelRef.current = {
      at: 0,
      encouraged: false,
      expectMore: false,
      gapMs: 0,
      pause: -1,
      played: [],
      words: 0,
    };
  }, []);

  /** How long a silence ends the turn, from how the speech sounds. */
  const endOfTurnMs = useCallback((text: string, now: number) => {
    const language = langRef.current;
    let ms: number = END_OF_TURN_MS.normal;
    if (soundsUnfinished(text, language)) {
      ms = END_OF_TURN_MS.unfinished;
    } else if (soundsLikeQuestion(text, language)) {
      ms = END_OF_TURN_MS.question;
    } else if (countWords(text) <= 3) {
      ms = END_OF_TURN_MS.short;
    } else if (lastFinalRef.current) {
      ms = END_OF_TURN_MS.finished;
    }
    const { at, expectMore } = backchannelRef.current;
    if (expectMore && now - at < 2500) {
      ms += AFTER_BACKCHANNEL_MS;
    }
    return ms;
  }, []);

  /** Which listening sound fits this pause, if any. */
  const backchannelFor = useCallback(
    (text: string, silence: number, endOfTurn: number, now: number) => {
      const language = langRef.current;
      const { current } = backchannelRef;
      const words = countWords(text);
      const sinceWords = words - current.words;
      if (
        clashesRef.current >= BACKCHANNEL_MAX_CLASHES ||
        current.pause === lastResultAtRef.current ||
        silence < BACKCHANNEL_MIN_PAUSE_MS ||
        // Leave room before the turn ends (the sound would talk over it).
        silence > endOfTurn - 250 ||
        words < BACKCHANNEL_FIRST_WORDS ||
        soundsLikeQuestion(text, language)
      ) {
        return null;
      }
      if (endsWithFiller(text)) {
        // "So the answer is… umm": reassure once per turn, otherwise "mm".
        if (
          silence < ENCOURAGE_PAUSE_MS ||
          (current.at > 0 && now - current.at < ENCOURAGE_GAP_MS)
        ) {
          return null;
        }
        return current.encouraged ? "continue" : "encourage";
      }
      if (
        current.at > 0 &&
        (sinceWords < BACKCHANNEL_GAP_WORDS || now - current.at < current.gapMs)
      ) {
        return null;
      }
      if (
        sinceWords >= ACKNOWLEDGE_WORDS &&
        !soundsUnfinished(text, language)
      ) {
        return "acknowledge";
      }
      // Decide once per pause whether this one gets a sound.
      current.pause = lastResultAtRef.current;
      return Math.random() < CONTINUE_CHANCE ? "continue" : null;
    },
    []
  );

  const tick = useCallback(() => {
    if (!activeRef.current) {
      return;
    }
    const now = performance.now();
    const text = fullText();
    if (!text) {
      const quietSince = Math.max(
        startedAtRef.current,
        lastResultAtRef.current
      );
      if (now - quietSince >= SLEEP_AFTER_MS) {
        halt();
        callbacksRef.current.onSleep();
      }
      return;
    }
    const silence = now - lastResultAtRef.current;
    const endOfTurn = endOfTurnMs(text, now);
    if (silence >= endOfTurn) {
      const said = removeBackchannelEchoes(text, backchannelRef.current.played);
      if (!said) {
        // Only the echo of our own "mm-hmm": keep listening.
        committedRef.current = "";
        sessionRef.current = { final: "", interim: "" };
        resetBackchannels();
        setLive("");
        return;
      }
      halt();
      callbacksRef.current.onTurn(said);
      return;
    }
    const kind = backchannelFor(text, silence, endOfTurn, now);
    if (!kind) {
      return;
    }
    const phrase = callbacksRef.current.onBackchannel(kind);
    const state = backchannelRef.current;
    state.pause = lastResultAtRef.current;
    if (phrase) {
      const words = countWords(text);
      backchannelRef.current = {
        ...state,
        at: now,
        encouraged: state.encouraged || kind === "encourage",
        expectMore: kind !== "acknowledge",
        gapMs: randomGap(),
        played: [...state.played, { atWord: words, phrase }],
        words,
      };
    }
  }, [backchannelFor, endOfTurnMs, fullText, halt, resetBackchannels]);

  /**
   * Starts listening for the student's next turn. The first call must come
   * from a tap (Safari needs the user gesture for the microphone).
   */
  const start = useCallback(
    (language?: CallLanguage) => {
      if (language) {
        // A new call: the listening sounds get a fresh chance.
        langRef.current = language;
        clashesRef.current = 0;
      }
      if (activeRef.current) {
        return true;
      }
      committedRef.current = "";
      sessionRef.current = { final: "", interim: "" };
      restartTimesRef.current = [];
      resetBackchannels();
      lastFinalRef.current = false;
      lastResultAtRef.current = 0;
      startedAtRef.current = performance.now();
      setLive("");
      activeRef.current = true;
      if (!startRecognition()) {
        activeRef.current = false;
        callbacksRef.current.onError(
          errorMessage("start-failed", langRef.current)
        );
        return false;
      }
      setListening(true);
      tickRef.current = setInterval(tick, 100);
      return true;
    },
    [resetBackchannels, startRecognition, tick]
  );

  /** Stops listening; what was heard so far is dropped. */
  const stop = useCallback(() => {
    halt();
    setLive("");
  }, [halt]);

  useEffect(() => halt, [halt]);

  return { listening, live, start, stop };
}
