"use client";

import { AnimatePresence, motion } from "framer-motion";
import { AudioLinesIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocalStorage } from "usehooks-ts";
import type { PersonaState } from "@/components/ai-elements/persona";
import {
  VoiceConversation,
  type VoiceMode,
  type VoiceTurn,
} from "@/components/ai-elements/voice-conversation";
import { useActiveChat } from "@/hooks/use-active-chat";
import { useCallListener } from "@/hooks/use-call-listener";
import { useSpeaker } from "@/hooks/use-speaker";
import {
  getRecognitionConstructor,
  voiceLanguageInfo,
} from "@/hooks/use-voice-recorder";
import type { ChatMessage } from "@/lib/types";
import { cn, generateUUID } from "@/lib/utils";
import { releaseAudioSession } from "@/lib/voice-audio";
import { type VoiceDepth, voiceDepth } from "@/lib/voice-depth";
import {
  BACKCHANNELS,
  type BackchannelKind,
  type CallLanguage,
  pickFor,
  spokenPart,
  spokenSection,
  toSpeakable,
} from "@/lib/voice-speech";
import { VoiceLanguageMenu } from "./voice-input";

/**
 * Voice conversation: the student talks with DZD AI hands-free. The
 * composer's speech button (shown while nothing is typed) asks for the
 * language, then a call card opens (assistant-ui's Voice Conversation with
 * the Persona globe). Each spoken turn is sent to the chat like a typed
 * message, and the reply is spoken by the device's own voice as it streams
 * in, so the conversation is also saved in the chat.
 */

const EASE = [0.32, 0.72, 0, 1] as const;
/** How long a new turn waits for the last (long) reply to finish. */
const QUEUE_WAIT_MS = 2500;

/** Said when a reply only has things to look at (a chart, a document…). */
const IN_CHAT: Record<CallLanguage, string> = {
  "en-IN": "I've popped that into the chat for you, have a look.",
  "si-LK": "මම ඒක chat එකේ දැම්මා.",
  "ta-LK": "அதை chat-இல் போட்டிருக்கிறேன்.",
};
const FAILED: Record<CallLanguage, string> = {
  "en-IN": "Oops, something went wrong on my side. Can you ask me that again?",
  "si-LK": "සමාවෙන්න, ඒකට උත්තර දෙන්න බැරි වුණා. ආයෙත් උත්සාහ කරන්න.",
  "ta-LK": "மன்னிக்கவும், பதில் சொல்ல முடியவில்லை. மீண்டும் முயற்சிக்கவும்.",
};

/**
 * Said when the assistant goes to search the web without saying so first,
 * so the student isn't left in silence.
 */
const HOLD_ON: Record<CallLanguage, readonly string[]> = {
  "en-IN": [
    "Give me a few seconds, I'll quickly check that online.",
    "Hang on, let me look that up for you.",
    "One sec, I'm checking the internet for that.",
    "Ooh, let me find the latest on that. Just a moment.",
  ],
  "si-LK": [
    "පොඩ්ඩක් ඉන්න, මම ඒක online බලලා කියන්නම්.",
    "තත්පර කීපයක් දෙන්න, මම හොයලා බලන්නම්.",
  ],
  "ta-LK": [
    "கொஞ்சம் இருங்க, நான் online-ல பார்த்து சொல்றேன்.",
    "ஒரு நிமிஷம், நான் தேடி பார்க்கிறேன்.",
  ],
};

/**
 * Said straight away when a question needs a thought-through answer (the
 * model thinks first), so the student knows it's coming.
 */
const THINKING: Record<CallLanguage, readonly string[]> = {
  "en-IN": [
    "Ooh, good one. Let me think about that properly.",
    "Okay, give me a second to think this through.",
    "Nice, let me put together a proper answer for you.",
    "Right, let me think about the best way to do this.",
    "Good question. Give me a moment to get this right.",
  ],
  "si-LK": [
    "හොඳ ප්‍රශ්නයක්. පොඩ්ඩක් හිතලා කියන්නම්.",
    "හරි, තත්පරයක් දෙන්න, හොඳට හිතලා උත්තරයක් දෙන්නම්.",
  ],
  "ta-LK": [
    "நல்ல கேள்வி. கொஞ்சம் யோசிச்சு சொல்றேன்.",
    "சரி, ஒரு நொடி, நல்லா யோசிச்சு பதில் சொல்றேன்.",
  ],
};

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

const SEARCH_TOOLS = new Set(["tool-webSearch", "tool-webFetch"]);

/** The reply went to search the web before saying anything. */
const searchedFirst = (message: ChatMessage) => {
  for (const part of message.parts) {
    if (part.type === "text" && toSpeakable(part.text)) {
      return false;
    }
    if (SEARCH_TOOLS.has(part.type)) {
      return true;
    }
  }
  return false;
};

/** The spoken text of a reply, and whether a written part follows it. */
const replyText = (message: ChatMessage) => {
  const { spoken, written } = spokenSection(
    message.parts
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n\n")
  );
  return { text: toSpeakable(spoken), written };
};

/** Voice conversations need speech recognition and a speech voice. */
export function useCallSupported() {
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(
      getRecognitionConstructor() !== null && "speechSynthesis" in window
    );
  }, []);
  return supported;
}

/** A soft globe for when the Persona animation can't load (no WebGL2). */
function FallbackOrb({ state }: { state: PersonaState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block size-28 rounded-full bg-[radial-gradient(circle_at_35%_30%,color-mix(in_oklab,var(--foreground)_55%,transparent),color-mix(in_oklab,var(--foreground)_12%,transparent)_70%)] transition-[scale,opacity] duration-500 ease-out",
        state === "asleep" && "scale-90 opacity-40",
        state === "idle" && "opacity-70",
        state === "thinking" && "animate-pulse",
        state === "listening" && "scale-[1.04]",
        state === "speaking" && "scale-110"
      )}
    />
  );
}

// The globe's animation runtime only loads when a call starts.
const Persona = dynamic(
  () => import("@/components/ai-elements/persona").then((mod) => mod.Persona),
  // The soft globe underneath shows while it loads.
  { loading: () => null, ssr: false }
);

export function VoiceCall({
  showTrigger,
  disabled,
}: {
  /** The speech button replaces send while nothing is typed. */
  showTrigger: boolean;
  disabled?: boolean;
}) {
  const supported = useCallSupported();
  const { chatId, messages, sendMessage, status, stop } = useActiveChat();
  const [lastLanguage, setLastLanguage] = useLocalStorage<CallLanguage>(
    "dzd-call-language",
    "en-IN"
  );

  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<CallLanguage>("en-IN");
  const [phase, setPhase] = useState<VoiceMode>("connecting");
  const [muted, setMuted] = useState(false);
  const [history, setHistory] = useState<VoiceTurn[]>([]);
  const [reply, setReply] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orbFailed, setOrbFailed] = useState(false);
  const [orbReady, setOrbReady] = useState(false);

  const openRef = useRef(false);
  const mutedRef = useRef(false);
  /** The student's turn waiting for (or getting) its spoken reply. */
  const pendingRef = useRef<{
    depth: VoiceDepth;
    userMessageId: string;
  } | null>(null);
  /** The last question's depth ("yes, go on" after a plan stays deep). */
  const lastDepthRef = useRef<VoiceDepth>("quick");
  const lastBackchannelRef = useRef("");
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    backchannel,
    cancel: cancelSpeech,
    feed,
    hasVoice,
    progress,
    speaking,
    unlock,
  } = useSpeaker(lang);

  const statusRef = useRef(status);
  statusRef.current = status;
  /** A turn said while the last (long) reply is still being written. */
  const queuedRef = useRef<{ id: string; text: string; at: number } | null>(
    null
  );
  /** Words the student heard of a reply they cut short (for the model). */
  const interruptedRef = useRef<number | null>(null);

  const send = useCallback(
    (id: string, text: string) => {
      const depth = voiceDepth(text, lastDepthRef.current);
      lastDepthRef.current = depth;
      pendingRef.current = { depth, userMessageId: id };
      window.history.pushState(
        {},
        "",
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/chat/${chatId}`
      );
      const interruptedAfter = interruptedRef.current;
      interruptedRef.current = null;
      sendMessage(
        { id, parts: [{ text, type: "text" }], role: "user" },
        {
          body: {
            voice: {
              depth,
              language: lang,
              ...(interruptedAfter === null
                ? {}
                : { interruptedAfterWords: interruptedAfter }),
            },
          },
        }
      );
    },
    [chatId, lang, sendMessage]
  );

  const handleTurn = useCallback(
    (text: string) => {
      if (!openRef.current) {
        return;
      }
      const id = generateUUID();
      setHistory((turns) => [...turns, { id, role: "user", text }]);
      setReply(null);
      setPhase("thinking");
      const busy =
        statusRef.current === "submitted" || statusRef.current === "streaming";
      if (busy) {
        // Sent as soon as the chat has finished writing the last reply.
        queuedRef.current = { at: Date.now(), id, text };
        return;
      }
      send(id, text);
    },
    [send]
  );

  // Send the turn that was waiting once the last reply is written. A long
  // reply gets a moment to finish, then stops (the chat keeps what it has)
  // so the student isn't kept waiting.
  useEffect(() => {
    const queued = queuedRef.current;
    if (!(queued && open)) {
      return;
    }
    if (status === "submitted" || status === "streaming") {
      const left = QUEUE_WAIT_MS - (Date.now() - queued.at);
      const timer = setTimeout(
        () => {
          if (queuedRef.current) {
            stop();
          }
        },
        Math.max(0, left)
      );
      return () => clearTimeout(timer);
    }
    queuedRef.current = null;
    send(queued.id, queued.text);
  }, [open, send, status, stop]);

  const handleBackchannel = useCallback(
    (kind: BackchannelKind) => {
      if (hasVoice !== true) {
        return null;
      }
      const options = BACKCHANNELS[lang][kind].filter(
        (option) => option !== lastBackchannelRef.current
      );
      const phrase = options[Math.floor(Math.random() * options.length)];
      if (!(phrase && backchannel(phrase))) {
        return null;
      }
      lastBackchannelRef.current = phrase;
      return phrase;
    },
    [backchannel, hasVoice, lang]
  );

  const handleListenError = useCallback((message: string) => {
    setError(message);
    mutedRef.current = true;
    setMuted(true);
  }, []);

  const handleSleep = useCallback(() => {
    mutedRef.current = true;
    setMuted(true);
  }, []);

  const listener = useCallListener({
    lang,
    onBackchannel: handleBackchannel,
    onError: handleListenError,
    onSleep: handleSleep,
    onTurn: handleTurn,
  });
  const { start: startListening, stop: stopListening } = listener;

  /** Back to the student's turn (unless the mic is off). */
  const listen = useCallback(() => {
    setPhase("listening");
    if (!mutedRef.current) {
      setError(null);
      startListening();
    }
  }, [startListening]);

  const finishReply = useCallback(
    (turn: VoiceTurn | null) => {
      pendingRef.current = null;
      if (turn) {
        setHistory((turns) => [...turns, turn]);
      }
      setReply(null);
      if (openRef.current) {
        listen();
      }
    },
    [listen]
  );

  // Speak the reply as it streams in.
  useEffect(() => {
    const pending = pendingRef.current;
    if (!(open && pending)) {
      return;
    }
    const settled = status === "ready" || status === "error";
    const index = messages.findLastIndex(
      (message) => message.id === pending.userMessageId
    );
    const answer =
      index === -1
        ? undefined
        : messages.slice(index + 1).find((m) => m.role === "assistant");
    if (!answer) {
      if (settled && status === "error") {
        const id = `failed-${pending.userMessageId}`;
        const text = FAILED[lang];
        setReply({ id, text });
        feed(id, text, true, () =>
          finishReply({ id, role: "assistant", text })
        );
      }
      return;
    }
    const { depth } = pending;
    const { text: answerText, written } = replyText(answer);
    let full = answerText;
    if (settled && !full) {
      full = status === "error" ? FAILED[lang] : IN_CHAT[lang];
    }
    // Lines at the start stay there, so the spoken text only grows.
    if (depth === "deep") {
      // Said while the model thinks (it covers a search, too).
      full = `${pickFor(THINKING[lang], answer.id)} ${full}`.trim();
    } else if (searchedFirst(answer)) {
      full = `${pickFor(HOLD_ON[lang], answer.id)} ${full}`.trim();
    }
    // Long replies are cut short in speech, and a written part (a plan, a
    // table) isn't spoken; the chat keeps all of it, and the call moves on
    // without waiting for the rest to be written.
    const { capped, text } = spokenPart(full, settled, lang, {
      depth,
      written,
    });
    setReply({ id: answer.id, text });
    feed(answer.id, text, settled || capped, () =>
      finishReply({ id: answer.id, role: "assistant", text })
    );
  }, [feed, finishReply, lang, messages, open, status]);

  // Thinking until the first words are spoken.
  useEffect(() => {
    if (speaking && pendingRef.current) {
      setPhase("speaking");
    }
  }, [speaking]);

  /** Opens the call. Runs in the tap on a language (needed by iOS). */
  const begin = useCallback(
    (picked: CallLanguage) => {
      setLastLanguage(picked);
      setLang(picked);
      unlock(picked);
      openRef.current = true;
      mutedRef.current = false;
      pendingRef.current = null;
      interruptedRef.current = null;
      lastDepthRef.current = "quick";
      setOpen(true);
      setOrbReady(false);
      setMuted(false);
      setHistory([]);
      setReply(null);
      setError(null);
      setPhase("connecting");
      startListening(picked);
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
      }
      connectTimerRef.current = setTimeout(() => {
        setPhase((current) =>
          current === "connecting" ? "listening" : current
        );
      }, 700);
    },
    [setLastLanguage, startListening, unlock]
  );

  const end = useCallback(() => {
    openRef.current = false;
    pendingRef.current = null;
    queuedRef.current = null;
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
    }
    stopListening();
    cancelSpeech();
    releaseAudioSession();
    setOpen(false);
    // A reply still streaming carries on into the chat.
  }, [cancelSpeech, stopListening]);

  const interrupt = useCallback(() => {
    if (queuedRef.current) {
      // Waiting to send: take the turn back and listen again.
      queuedRef.current = null;
      listen();
      return;
    }
    if (!pendingRef.current) {
      return;
    }
    cancelSpeech();
    // Keep what was said, so the transcript shows where it stopped.
    let turn: VoiceTurn | null = null;
    interruptedRef.current = 0;
    if (reply) {
      const said =
        progress && progress.turnId === reply.id
          ? reply.text.slice(0, progress.wordEnd).trim()
          : "";
      // The "hang on" / "let me think" line isn't part of the saved reply.
      const prefix = [...THINKING[lang], ...HOLD_ON[lang]].find((line) =>
        said.startsWith(line)
      );
      const heard = prefix ? said.slice(prefix.length) : said;
      interruptedRef.current = countWords(heard);
      turn = said
        ? { id: reply.id, role: "assistant", text: `${said}…` }
        : null;
    }
    // Listening starts inside the tap; the reply stops streaming.
    finishReply(turn);
    if (status === "submitted" || status === "streaming") {
      stop();
    }
  }, [cancelSpeech, finishReply, lang, listen, progress, reply, status, stop]);

  const toggleMute = useCallback(() => {
    if (mutedRef.current) {
      mutedRef.current = false;
      setMuted(false);
      setError(null);
      if (!pendingRef.current) {
        listen();
      }
      return;
    }
    mutedRef.current = true;
    setMuted(true);
    stopListening();
  }, [listen, stopListening]);

  // Leaving the chat ends the call.
  const callChatRef = useRef(chatId);
  useEffect(() => {
    if (!open) {
      callChatRef.current = chatId;
      return;
    }
    if (callChatRef.current !== chatId) {
      end();
    }
  }, [chatId, end, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [open]);

  // Escape ends the call.
  const endRef = useRef(end);
  endRef.current = end;
  useEffect(() => {
    if (!open) {
      return;
    }
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        endRef.current();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  const handleOrbError = useCallback(() => setOrbFailed(true), []);
  const handleOrbLoad = useCallback(() => setOrbReady(true), []);
  // The globe's animation couldn't load in time: keep the soft globe.
  useEffect(() => {
    if (!open || orbReady || orbFailed) {
      return;
    }
    const timer = setTimeout(() => setOrbFailed(true), 8000);
    return () => clearTimeout(timer);
  }, [open, orbFailed, orbReady]);

  const personaState: PersonaState = (() => {
    if (muted) {
      return "asleep";
    }
    if (phase === "connecting") {
      return "idle";
    }
    return phase;
  })();

  const transcript = useMemo(() => {
    const turns: VoiceTurn[] = [...history];
    const replyProgress =
      reply && progress?.turnId === reply.id ? progress : null;
    if (reply && replyProgress) {
      // Shown once the voice reaches it, following along word by word.
      turns.push({
        id: reply.id,
        progress: replyProgress,
        role: "assistant",
        text: reply.text,
      });
    } else if (!reply && phase === "listening" && listener.live) {
      turns.push({
        id: "live",
        live: true,
        role: "user",
        text: listener.live,
      });
    }
    // The last exchange; the whole conversation is saved in the chat.
    return turns.filter((turn) => turn.text).slice(-2);
  }, [history, listener.live, phase, progress, reply]);

  const language = voiceLanguageInfo(lang);
  let notice: string | null = error;
  if (!notice && hasVoice === false) {
    notice = `This device has no ${language.name} voice, so replies are shown as text.`;
  }
  let hint: string | undefined;
  if (phase === "listening") {
    hint = `Listening · ${language.label}`;
  } else if (phase === "thinking") {
    hint = "Tap the globe to stop";
  }

  if (!supported) {
    return null;
  }

  return (
    <>
      {showTrigger ? (
        <VoiceLanguageMenu
          icon={AudioLinesIcon}
          lang={lastLanguage}
          onPick={begin}
          testIdPrefix="call-language"
          trigger={
            <button
              aria-label="Talk with DZD AI"
              className="flex size-7 cursor-pointer items-center justify-center rounded-xl bg-primary text-primary-foreground outline-none transition-[opacity,scale] duration-200 hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 max-md:size-9 max-md:rounded-full"
              data-testid="voice-call-button"
              disabled={disabled}
              title="Talk with DZD AI"
              type="button"
            >
              <AudioLinesIcon className="size-4" />
            </button>
          }
          triggerDisabled={disabled}
        />
      ) : null}
      {typeof document === "undefined"
        ? null
        : createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  animate={{ opacity: 1 }}
                  aria-label="Voice conversation"
                  aria-modal="true"
                  className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 p-4 backdrop-blur-md"
                  data-testid="voice-call"
                  exit={{ opacity: 0 }}
                  initial={{ opacity: 0 }}
                  key="voice-call"
                  role="dialog"
                  transition={{ duration: 0.25, ease: EASE }}
                >
                  <motion.div
                    animate={{
                      filter: "blur(0px)",
                      opacity: 1,
                      scale: 1,
                      y: 0,
                    }}
                    className="w-full max-w-sm"
                    exit={{
                      filter: "blur(4px)",
                      opacity: 0,
                      scale: 0.97,
                      y: 8,
                    }}
                    initial={{
                      filter: "blur(6px)",
                      opacity: 0,
                      scale: 0.96,
                      y: 12,
                    }}
                    transition={{ duration: 0.35, ease: EASE }}
                  >
                    <VoiceConversation
                      amplitude={0}
                      className="max-w-sm shadow-xl"
                      hint={hint}
                      mode={phase}
                      muted={muted}
                      notice={notice}
                      onEnd={end}
                      onInterrupt={interrupt}
                      onToggleMute={toggleMute}
                      orb={
                        <span className="grid size-32 place-items-center">
                          <span
                            className={cn(
                              "col-start-1 row-start-1 transition-opacity duration-500",
                              orbReady && !orbFailed && "opacity-0"
                            )}
                          >
                            <FallbackOrb state={personaState} />
                          </span>
                          {orbFailed ? null : (
                            <Persona
                              className="col-start-1 row-start-1 size-32"
                              onLoad={handleOrbLoad}
                              onLoadError={handleOrbError}
                              state={personaState}
                              variant="mana"
                            />
                          )}
                        </span>
                      }
                      state={personaState}
                      transcript={transcript}
                    />
                  </motion.div>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )}
    </>
  );
}
