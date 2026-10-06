"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getRecognitionConstructor,
  isAndroid,
  type Recognition,
} from "@/hooks/use-voice-recorder";
import { type CallLanguage, removeBackchannelEchoes } from "@/lib/voice-speech";

/**
 * Listens to the student in a voice conversation with the browser's speech
 * recognition, like the voice messages do. A turn ends after a short
 * silence; during shorter pauses mid-thought the assistant may make a soft
 * listening sound ("mm-hmm"), the way a person on a call does.
 */

/** Silence that ends the student's turn. */
const END_OF_TURN_MS = 1300;
/** A backchannel just played: the student is probably carrying on. */
const AFTER_BACKCHANNEL_MS = 600;
/** A pause this long (but shorter than the end of turn) gets a "mm-hmm". */
const BACKCHANNEL_PAUSE_MS: readonly [number, number] = [650, 1000];
const BACKCHANNEL_MIN_WORDS = 7;
const BACKCHANNEL_GAP_MS = 7000;
/** Nobody has spoken for this long: the call goes to sleep (mic off). */
const SLEEP_AFTER_MS = 90_000;

const isIOS = () =>
  typeof navigator !== "undefined" &&
  (/iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

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
  /** Play a listening sound now; false if it couldn't. */
  onBackchannel: () => boolean;
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
  const backchannelRef = useRef({ at: 0, count: 0, words: 0 });
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
    const backchannel = backchannelRef.current;
    const recentBackchannel = backchannel.at > 0 && now - backchannel.at < 2500;
    const endOfTurn =
      END_OF_TURN_MS + (recentBackchannel ? AFTER_BACKCHANNEL_MS : 0);
    if (silence >= endOfTurn) {
      const said = removeBackchannelEchoes(
        text,
        langRef.current,
        backchannel.count
      );
      if (!said) {
        // Only the echo of our own "mm-hmm": keep listening.
        committedRef.current = "";
        sessionRef.current = { final: "", interim: "" };
        backchannelRef.current = { at: 0, count: 0, words: 0 };
        setLive("");
        return;
      }
      halt();
      callbacksRef.current.onTurn(said);
      return;
    }
    const words = countWords(text);
    if (
      silence >= BACKCHANNEL_PAUSE_MS[0] &&
      silence <= BACKCHANNEL_PAUSE_MS[1] &&
      words - backchannel.words >= BACKCHANNEL_MIN_WORDS &&
      (backchannel.at === 0 || now - backchannel.at >= BACKCHANNEL_GAP_MS) &&
      !/[?？]\s*$/.test(text) &&
      // iOS stops recognising when the page plays sound.
      !isIOS() &&
      callbacksRef.current.onBackchannel()
    ) {
      backchannelRef.current = {
        at: now,
        count: backchannel.count + 1,
        words,
      };
    }
  }, [fullText, halt]);

  /**
   * Starts listening for the student's next turn. The first call must come
   * from a tap (Safari needs the user gesture for the microphone).
   */
  const start = useCallback(
    (language?: CallLanguage) => {
      if (language) {
        langRef.current = language;
      }
      if (activeRef.current) {
        return true;
      }
      committedRef.current = "";
      sessionRef.current = { final: "", interim: "" };
      restartTimesRef.current = [];
      backchannelRef.current = { at: 0, count: 0, words: 0 };
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
    [startRecognition, tick]
  );

  /** Stops listening; what was heard so far is dropped. */
  const stop = useCallback(() => {
    halt();
    setLive("");
  }, [halt]);

  useEffect(() => halt, [halt]);

  return { listening, live, start, stop };
}
