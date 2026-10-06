"use client";

import { motion } from "framer-motion";
import { CheckIcon, MicIcon, SquareIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  VOICE_LANGUAGES,
  type VoiceLanguage,
  type VoiceState,
  voiceLanguageInfo,
} from "@/hooks/use-voice-recorder";
import { cn } from "@/lib/utils";

const EASE = [0.32, 0.72, 0, 1] as const;

/*
 * Dictation, from assistant-ui Elements (MIT):
 * https://www.assistant-ui.com/elements/composer-voice
 * Same markup and classes as ComposerVoice / ComposerVoiceButton; the bars
 * follow the microphone's live loudness instead of a timer-driven sine.
 */
const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";
const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none";
const mono = "font-mono text-[11px] tracking-tight";

const BARS = Array.from({ length: 14 }, (_, index) => index);
const IDLE_BAR = 3;
const MAX_BAR = 24; // the bar row is h-6

/**
 * Bar height for the live loudness: the design's ripple (a sine over the
 * bar index, drifting with time) scaled by how loud the student is.
 */
function liveBarHeight(bar: number, timeMs: number, level: number) {
  const ripple = Math.abs(Math.sin(bar * 1.35 + timeMs * 0.0055));
  return Math.min(MAX_BAR, IDLE_BAR + level * (4 + ripple * 17));
}

function formatSeconds(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function ComposerVoice({
  recording,
  seconds,
  getLevel,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  recording: boolean;
  seconds: number;
  /** Live loudness 0..1, read every frame while recording. */
  getLevel: () => number;
}) {
  const barsRef = useRef<HTMLDivElement>(null);
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  // Heights are written straight to the DOM every frame, so the bars move
  // with the voice without re-rendering React 60 times a second.
  useEffect(() => {
    const bars = Array.from(barsRef.current?.children ?? []) as HTMLElement[];
    if (!recording) {
      for (const bar of bars) {
        bar.style.height = `${IDLE_BAR}px`;
      }
      return;
    }
    let level = 0;
    let frame = 0;
    const tick = (now: number) => {
      const target = Math.min(1, Math.max(0, getLevelRef.current()));
      // Fast attack, quick release: syllables pop, silence settles.
      level += (target - level) * (target > level ? 0.6 : 0.25);
      // A faint ripple while quiet shows it is listening.
      const shown = Math.max(level, 0.08);
      for (const [index, bar] of bars.entries()) {
        bar.style.height = `${liveBarHeight(index, now, shown).toFixed(1)}px`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [recording]);

  return (
    <div
      className={cn("flex min-h-11 items-center gap-3 ps-3", className)}
      data-recording={recording || undefined}
      data-slot="composer-voice"
      {...props}
    >
      {recording ? (
        <span
          aria-hidden
          className="size-1.5 animate-pulse rounded-full bg-blue-500 dark:bg-blue-400"
        />
      ) : null}
      <div
        aria-hidden
        className="flex h-6 items-center gap-[3px]"
        ref={barsRef}
      >
        {BARS.map((bar) => (
          <span
            className={cn(
              "w-0.5 rounded-full transition-[height,background-color] duration-150 motion-reduce:transition-none",
              recording ? "bg-foreground/50" : "bg-foreground/25"
            )}
            key={bar}
            // Live updates: a short transition keeps them smooth but on time.
            style={{
              height: IDLE_BAR,
              transitionDuration: recording ? "70ms" : undefined,
            }}
          />
        ))}
      </div>
      {recording ? (
        <span className={cn(mono, "text-foreground/40 tabular-nums")}>
          {formatSeconds(seconds)}
        </span>
      ) : (
        <span className="shimmer relative text-[13px] text-foreground/55 motion-reduce:animate-none">
          Transcribing
        </span>
      )}
    </div>
  );
}

export function ComposerVoiceButton({
  active,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & { active: boolean }) {
  return (
    <button
      aria-label={active ? "Stop recording" : "Start voice input"}
      className={cn(
        active
          ? cn(
              inkButton,
              "flex size-8 items-center justify-center rounded-full"
            )
          : cn(ghostButton, "size-8"),
        className
      )}
      data-slot="composer-voice-button"
      type="button"
      {...props}
    >
      {active ? (
        <SquareIcon className="size-3 fill-current" />
      ) : (
        <MicIcon className="size-4" />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ panel */

function useElapsedSeconds(startedAt: number, running: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) {
      return;
    }
    const tick = () =>
      setSeconds(
        Math.max(0, Math.floor((performance.now() - startedAt) / 1000))
      );
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return seconds;
}

/**
 * Replaces the textarea while a voice message is recorded: the live
 * transcript above the dictation waveform.
 */
export function VoicePanel({
  getLevel,
  lang,
  recording,
  startedAt,
  transcript,
}: {
  getLevel: () => number;
  /** The language being spoken (chosen before recording started). */
  lang: VoiceLanguage;
  /** False while settling (transcribing / sending). */
  recording: boolean;
  startedAt: number;
  transcript: { final: string; interim: string };
}) {
  const seconds = useElapsedSeconds(startedAt, recording);
  const empty = !(transcript.final || transcript.interim);

  return (
    <motion.div
      animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
      className="absolute inset-0 z-10 flex flex-col justify-between overflow-hidden rounded-t-2xl pt-3.5"
      data-testid="voice-panel"
      exit={{ filter: "blur(6px)", opacity: 0, y: 4 }}
      initial={{ filter: "blur(6px)", opacity: 0, y: 4 }}
      transition={{ duration: 0.3, ease: EASE }}
    >
      <div
        aria-live="polite"
        className="flex max-h-[3.4rem] flex-col justify-end overflow-hidden px-4 text-[14px] leading-relaxed"
      >
        {empty ? (
          <span className="select-none text-foreground/35">
            {recording ? `Listening in ${voiceLanguageInfo(lang).label}…` : ""}
          </span>
        ) : (
          <p className="break-words">
            <span className="text-foreground/80">{transcript.final}</span>
            {transcript.interim ? (
              <span className="text-foreground/55">
                {transcript.final ? " " : ""}
                {transcript.interim}
              </span>
            ) : null}
          </p>
        )}
      </div>
      <ComposerVoice
        className="ps-4"
        getLevel={getLevel}
        recording={recording}
        seconds={seconds}
      />
    </motion.div>
  );
}

/* --------------------------------------------------------------- controls */

/** Footer while recording: the chosen language, cancel, and stop (sends). */
export function VoiceControls({
  lang,
  onCancel,
  onSend,
  state,
}: {
  lang: VoiceLanguage;
  onCancel: () => void;
  onSend: () => void;
  state: VoiceState | "sending";
}) {
  const recording = state === "listening";
  const language = voiceLanguageInfo(lang);

  // Esc cancels, Enter stops and sends (unless a menu is handling keys).
  useEffect(() => {
    if (state === "idle" || state === "sending") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("[role=menu]")) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && !event.shiftKey && recording) {
        event.preventDefault();
        onSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onSend, recording, state]);

  return (
    <div className="flex w-full items-center justify-between gap-2">
      {/* Read-only: the language is chosen before recording starts. */}
      <span
        className="flex h-8 select-none items-center rounded-full px-2.5 text-[12px] text-foreground/55"
        data-testid="voice-language"
        title={`Speaking ${language.name}`}
      >
        <span className="sr-only">Speaking </span>
        {language.label}
      </span>
      <div className="flex items-center gap-1">
        <button
          aria-label={
            state === "finishing"
              ? "Cancel transcription"
              : "Cancel voice message"
          }
          className={cn(
            ghostButton,
            "size-8 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 max-md:size-9"
          )}
          data-testid="voice-cancel"
          disabled={state === "sending" || state === "idle"}
          onClick={onCancel}
          type="button"
        >
          <XIcon className="size-4" />
        </button>
        <ComposerVoiceButton
          active={recording}
          aria-label={
            recording ? "Stop and send voice message" : "Transcribing"
          }
          className="cursor-pointer disabled:cursor-default disabled:opacity-60 max-md:size-9"
          data-testid="voice-send"
          disabled={!recording}
          onClick={onSend}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- mic button */

/**
 * The mic asks which language the student will speak first, and recording
 * starts only once they pick one, so the recogniser is set up for the right
 * language from the first word. The last language used is marked.
 */
export function MicButton({
  disabled,
  lang,
  onPick,
}: {
  disabled: boolean;
  /** The language used last time. */
  lang: VoiceLanguage;
  onPick: (lang: VoiceLanguage) => void;
}) {
  const handleCloseAutoFocus = useCallback((event: Event) => {
    // Recording replaces the mic button; don't pull focus back to it.
    event.preventDefault();
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <ComposerVoiceButton
          active={false}
          aria-label="Record a voice message"
          className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent max-md:size-9"
          data-testid="voice-button"
          disabled={disabled}
          title="Record a voice message"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        data-testid="voice-language-menu"
        onCloseAutoFocus={handleCloseAutoFocus}
        side="top"
      >
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          Which language will you speak?
        </DropdownMenuLabel>
        {VOICE_LANGUAGES.map((option) => (
          <LanguageItem
            key={option.id}
            last={option.id === lang}
            onPick={onPick}
            option={option}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LanguageItem({
  last,
  onPick,
  option,
}: {
  last: boolean;
  onPick: (lang: VoiceLanguage) => void;
  option: (typeof VOICE_LANGUAGES)[number];
}) {
  const handleSelect = useCallback(() => onPick(option.id), [onPick, option]);
  return (
    <DropdownMenuItem
      className={cn(
        "min-h-10 cursor-pointer gap-2 text-[14px]",
        last && "bg-foreground/[0.05]"
      )}
      data-last={last || undefined}
      data-testid={`voice-language-${option.speech}`}
      onSelect={handleSelect}
    >
      <MicIcon className="size-3.5 text-muted-foreground" />
      <span className="flex-1">{option.label}</span>
      {option.label === option.name ? null : (
        <span className="text-[11px] text-muted-foreground">{option.name}</span>
      )}
      {last ? (
        <CheckIcon
          aria-label="Last used"
          className="size-3.5 text-foreground/70"
        />
      ) : (
        <span aria-hidden className="size-3.5" />
      )}
    </DropdownMenuItem>
  );
}
