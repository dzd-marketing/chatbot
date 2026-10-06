"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type CallLanguage,
  pickVoice,
  splitSentences,
} from "@/lib/voice-speech";

/**
 * Speaks the assistant's replies in a voice conversation with the device's
 * built-in voices (speechSynthesis): sentence by sentence as the reply
 * streams in, reporting which word is being said so the transcript can
 * follow along. Where the device has no voice for the language (iPhones
 * have no Sinhala voice) the reply is "read" silently at speaking pace, so
 * the conversation still flows and the text still follows along.
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

type Sentence = { text: string; start: number };

/** Typical speaking pace, used when the voice doesn't report words. */
const CHARS_PER_SECOND = 14.5;
const RATE = 1;

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

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const turnRef = useRef<{
    id: string;
    text: string;
    queued: number;
    sentences: Sentence[];
    complete: boolean;
    finished: boolean;
  } | null>(null);
  // Bumped to drop events from utterances that were cancelled.
  const tokenRef = useRef(0);
  const busyRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDoneRef = useRef<(() => void) | null>(null);
  // Keeps utterances alive: Chrome drops events of collected ones.
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

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

  /** Unlocks speech on iOS; call from the tap that opens the call. */
  const unlock = useCallback(() => {
    if (!hasSynthesis()) {
      return;
    }
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    window.speechSynthesis.speak(utterance);
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
    setSpeaking(true);
    tokenRef.current += 1;
    const token = tokenRef.current;
    const sentenceEnd = sentence.start + sentence.text.length;
    const lastWordStart = Math.max(
      sentence.start,
      turn.text.lastIndexOf(" ", sentenceEnd - 1) + 1
    );
    const startedAt = performance.now();
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
      busyRef.current = false;
      show(sentenceEnd);
      speakNext();
    };

    show(sentence.start);
    // Follow along by time until (unless) the voice reports words.
    tickRef.current = setInterval(() => {
      if (token !== tokenRef.current || heardWord) {
        return;
      }
      const elapsed = (performance.now() - startedAt) / 1000;
      const estimate = sentence.start + elapsed * CHARS_PER_SECOND * RATE;
      // Stay on the word the estimate is in (at most the last word).
      const before = turn.text.lastIndexOf(" ", estimate) + 1;
      show(Math.min(before, lastWordStart));
    }, 90);

    const expectedMs =
      (sentence.text.length / (CHARS_PER_SECOND * RATE)) * 1000;
    const synth = hasSynthesis() ? window.speechSynthesis : null;
    const voiceNow = voiceRef.current;
    if (!(synth && voiceNow)) {
      // No voice: "read" at speaking pace.
      timersRef.current.push(setTimeout(next, expectedMs + 250));
      return;
    }
    const utterance = new SpeechSynthesisUtterance(sentence.text);
    utterance.voice = voiceNow;
    utterance.lang = voiceNow.lang;
    utterance.rate = RATE;
    utterance.pitch = 1;
    utterance.onboundary = (event) => {
      if (token !== tokenRef.current || event.name !== "word") {
        return;
      }
      heardWord = true;
      show(sentence.start + event.charIndex);
    };
    utterance.onend = next;
    utterance.onerror = next;
    utteranceRef.current = utterance;
    synth.speak(utterance);
    // Safety net: some browsers occasionally never fire "end".
    timersRef.current.push(setTimeout(next, expectedMs * 2.5 + 4000));
  }, [clearTimers, finishIfDone]);

  /**
   * The reply so far (speakable text). New complete sentences are queued;
   * with `complete` the rest is too, and `onDone` runs once it's all said.
   */
  const feed = useCallback(
    (turnId: string, text: string, complete: boolean, onDone?: () => void) => {
      let turn = turnRef.current;
      if (!turn || turn.id !== turnId) {
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
      const sentences = splitSentences(text, complete);
      // Keep sentences already queued; add the new ones with their offsets.
      let searchFrom = turn.sentences.at(-1)
        ? (turn.sentences.at(-1) as Sentence).start +
          (turn.sentences.at(-1) as Sentence).text.length
        : 0;
      for (const sentence of sentences.slice(turn.sentences.length)) {
        const start = text.indexOf(sentence, searchFrom);
        const at = start === -1 ? searchFrom : start;
        turn.sentences.push({ start: at, text: sentence });
        searchFrom = at + sentence.length;
      }
      if (busyRef.current) {
        return;
      }
      speakNext();
    },
    [speakNext]
  );

  /** Stops speaking at once (interrupt, end of call). */
  const cancel = useCallback(() => {
    tokenRef.current += 1;
    clearTimers();
    busyRef.current = false;
    turnRef.current = null;
    onDoneRef.current = null;
    utteranceRef.current = null;
    setSpeaking(false);
    setProgress(null);
    if (hasSynthesis()) {
      window.speechSynthesis.cancel();
    }
  }, [clearTimers]);

  /** A soft "mm-hmm" while the student pauses. False if it can't play. */
  const backchannel = useCallback((phrase: string) => {
    const voiceNow = voiceRef.current;
    if (!(hasSynthesis() && voiceNow) || busyRef.current) {
      return false;
    }
    const utterance = new SpeechSynthesisUtterance(phrase);
    utterance.voice = voiceNow;
    utterance.lang = voiceNow.lang;
    utterance.rate = 1.05;
    utterance.volume = 0.55;
    window.speechSynthesis.speak(utterance);
    return true;
  }, []);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      clearTimers();
      if (hasSynthesis()) {
        window.speechSynthesis.cancel();
      }
    },
    [clearTimers]
  );

  return {
    backchannel,
    cancel,
    feed,
    hasVoice,
    progress,
    speaking,
    unlock,
    voice,
  };
}
