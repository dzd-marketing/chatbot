"use client";

/*
 * Voice Conversation, from assistant-ui Elements (MIT):
 * https://www.assistant-ui.com/elements/voice-conversation
 * Same anatomy and classes as VoiceConversation, with these changes for
 * TheStudent:
 * - `orb` replaces the ring orb (the Persona globe sits there);
 * - the five call states are shown as a row of indicators under it;
 * - the assistant's turn follows the voice: words already said are solid,
 *   the word being said is marked, and text not yet reached stays faint;
 * - neutral tones instead of blue.
 * The surface classes and range helper it imports are copied below.
 */

import {
  BrainIcon,
  CircleIcon,
  createLucideIcon,
  MegaphoneIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const paper = "bg-background border border-border/60 dark:bg-popover";
const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";
const mono = "font-mono text-[11px] tracking-tight";

// lucide's "eye-closed" (ISC); newer than the lucide-react in this app.
const EyeClosedIcon = createLucideIcon("EyeClosed", [
  ["path", { d: "m15 18-.722-3.25", key: "1j64jw" }],
  ["path", { d: "M2 8a10.645 10.645 0 0 0 20 0", key: "1e7gxb" }],
  ["path", { d: "m20 15-1.726-2.05", key: "1cnuld" }],
  ["path", { d: "m4 15 1.726-2.05", key: "1o7ctv" }],
  ["path", { d: "m9 18 .722-3.25", key: "1ihu8y" }],
]);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export type VoiceMode = "connecting" | "listening" | "thinking" | "speaking";

/** How far the voice has got through an assistant turn (text offsets). */
export type VoiceProgress = {
  spoken: number;
  wordEnd: number;
  sentenceEnd: number;
  done: boolean;
};

export interface VoiceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant turns being spoken: highlight follows the voice. */
  progress?: VoiceProgress | null;
  /** User turn still being heard. */
  live?: boolean;
}

const CAPTION: Record<VoiceMode, string> = {
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  thinking: "Thinking",
};

const HINT: Record<VoiceMode, string> = {
  connecting: "Opening the mic",
  listening: "Listening for you",
  speaking: "Playing the reply",
  thinking: "Working on it",
};

/* ----------------------------------------------------------- state row */

export type VoiceState = "idle" | "listening" | "thinking" | "speaking" | "asleep";

const STATES: readonly {
  id: VoiceState;
  label: string;
  icon: typeof CircleIcon;
}[] = [
  { icon: CircleIcon, id: "idle", label: "Idle" },
  { icon: MicIcon, id: "listening", label: "Listening" },
  { icon: BrainIcon, id: "thinking", label: "Thinking" },
  { icon: MegaphoneIcon, id: "speaking", label: "Speaking" },
  { icon: EyeClosedIcon, id: "asleep", label: "Asleep" },
];

/** The call's state as a row of indicators (the current one is filled). */
export function VoiceStates({
  state,
  className,
}: {
  state: VoiceState;
  className?: string;
}) {
  return (
    <ButtonGroup
      aria-label="Conversation state"
      className={className}
      data-slot="voice-states"
      orientation="horizontal"
      role="group"
    >
      {STATES.map(({ icon: Icon, id, label }) => (
        <Tooltip key={id}>
          <TooltipTrigger asChild>
            <Button
              aria-current={state === id ? "true" : undefined}
              aria-label={label}
              className="cursor-default transition-colors duration-300"
              data-state-id={id}
              size="icon-sm"
              type="button"
              variant={state === id ? "default" : "outline"}
            >
              <Icon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{label}</p>
          </TooltipContent>
        </Tooltip>
      ))}
    </ButtonGroup>
  );
}

/* ---------------------------------------------------------- transcript */

function SpokenText({ text, progress }: { text: string; progress: VoiceProgress }) {
  if (progress.done) {
    return <>{text}</>;
  }
  const spoken = clamp(progress.spoken, 0, text.length);
  const wordEnd = clamp(progress.wordEnd, spoken, text.length);
  const shownEnd = clamp(progress.sentenceEnd, wordEnd, text.length);
  return (
    <>
      {text.slice(0, spoken)}
      <span
        className="rounded-[3px] bg-foreground/10 text-foreground transition-colors duration-200"
        data-current-word
      >
        {text.slice(spoken, wordEnd)}
      </span>
      <span className="text-foreground/30">{text.slice(wordEnd, shownEnd)}</span>
    </>
  );
}

function TurnText({ turn }: { turn: VoiceTurn }) {
  if (turn.role === "assistant" && turn.progress) {
    return <SpokenText progress={turn.progress} text={turn.text} />;
  }
  return <>{turn.text}</>;
}

export function VoiceConversation({
  mode,
  amplitude,
  transcript,
  muted,
  onToggleMute,
  onInterrupt,
  onEnd,
  orb,
  state,
  hint,
  notice,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "mode"
  | "amplitude"
  | "transcript"
  | "muted"
  | "onToggleMute"
  | "onInterrupt"
  | "onEnd"
> & {
  mode: VoiceMode;
  amplitude: number;
  transcript: readonly VoiceTurn[];
  muted?: boolean;
  onToggleMute?: () => void;
  onInterrupt?: () => void;
  onEnd?: () => void;
  /** Replaces the ring orb (e.g. the Persona globe). */
  orb?: ReactNode;
  /** Shows the state indicators under the orb. */
  state?: VoiceState;
  /** Replaces the default hint for the mode. */
  hint?: string;
  /** A short note under the transcript. */
  notice?: ReactNode;
}) {
  const level = clamp(amplitude, 0, 1);
  const active = mode === "listening" || mode === "speaking";
  const canInterrupt =
    (mode === "speaking" || mode === "thinking") && onInterrupt !== undefined;

  // Keep the newest words (or the word being said) in view.
  const transcriptRef = useRef<HTMLDivElement>(null);
  const lastTurn = transcript.at(-1);
  const scrollKey = `${lastTurn?.id}:${lastTurn?.text.length}:${lastTurn?.progress?.spoken}`;
  useEffect(() => {
    const box = transcriptRef.current;
    if (!(box && scrollKey)) {
      return;
    }
    const word = box.querySelector<HTMLElement>("[data-current-word]");
    if (!word) {
      box.scrollTo({ behavior: "smooth", top: box.scrollHeight });
      return;
    }
    // Keep the line being said about a third of the way down, moving on
    // smoothly line by line as the voice reaches it.
    const lineTop =
      word.getBoundingClientRect().top -
      box.getBoundingClientRect().top +
      box.scrollTop;
    const target = Math.max(0, lineTop - box.clientHeight * 0.35);
    if (Math.abs(target - box.scrollTop) > 4) {
      box.scrollTo({ behavior: "smooth", top: target });
    }
  }, [scrollKey]);

  // Older lines fade out at the top once the transcript has scrolled.
  const handleTranscriptScroll = useCallback(() => {
    const box = transcriptRef.current;
    if (box) {
      box.dataset.scrolled = String(box.scrollTop > 2);
    }
  }, []);

  let hintText = hint ?? HINT[mode];
  if (muted) {
    hintText = "Mic off";
  } else if (mode === "speaking" && onInterrupt) {
    hintText = "Tap to interrupt";
  }

  return (
    <div
      className={cn(
        paper,
        "flex w-full max-w-xs flex-col items-center gap-4 rounded-[28px] px-5 py-5",
        className
      )}
      data-slot="voice-conversation"
      {...props}
    >
      <button
        aria-label="Interrupt the assistant"
        className={cn(
          "relative flex items-center justify-center rounded-full outline-none focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:cursor-default",
          orb ? "size-32 cursor-pointer" : "size-24"
        )}
        disabled={!canInterrupt}
        onClick={onInterrupt}
        type="button"
      >
        {orb ?? (
          <>
            <span
              aria-hidden
              className="absolute rounded-full bg-foreground/[0.05] transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
              style={{
                height: "6rem",
                opacity: active ? 1 : 0.5,
                transform: `scale(${active ? 0.72 + level * 0.28 : 0.62})`,
                width: "6rem",
              }}
            />
            <span
              aria-hidden
              className="absolute rounded-full bg-foreground/[0.08] transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
              style={{
                height: "4.25rem",
                transform: `scale(${active ? 0.8 + level * 0.22 : 0.7})`,
                width: "4.25rem",
              }}
            />
            <span
              aria-hidden
              className={cn(
                "relative size-10 rounded-full transition-[transform,background-color] duration-150 ease-out motion-reduce:transition-none",
                mode === "connecting" && "animate-pulse bg-foreground/20",
                mode === "listening" && "bg-foreground/80",
                mode === "thinking" && "animate-pulse bg-foreground/30",
                mode === "speaking" && "bg-foreground"
              )}
              style={{
                transform: `scale(${active ? 0.9 + level * 0.2 : 0.85})`,
              }}
            />
          </>
        )}
      </button>

      {state ? <VoiceStates state={state} /> : null}

      <div className="flex flex-col items-center gap-1">
        <span className="font-medium text-[13.5px]" data-testid="voice-caption">
          {muted ? "Asleep" : CAPTION[mode]}
        </span>
        <span className={cn(mono, "text-foreground/35")}>{hintText}</span>
      </div>

      <div
        aria-live="polite"
        className="flex max-h-44 min-h-[4.5rem] w-full flex-col gap-1.5 overflow-y-auto [scrollbar-width:none] data-[scrolled=true]:[mask-image:linear-gradient(to_bottom,transparent,black_28px)] [&::-webkit-scrollbar]:hidden"
        data-testid="voice-transcript"
        onScroll={handleTranscriptScroll}
        ref={transcriptRef}
      >
        {transcript.map((turn) => (
          <div
            className="fade-in slide-in-from-bottom-1 flex animate-in gap-2 fill-mode-both text-[13px] leading-relaxed duration-300"
            data-role={turn.role}
            key={turn.id}
          >
            <span
              className={cn(
                mono,
                "w-8 shrink-0 pt-px",
                turn.role === "user"
                  ? "text-foreground/30"
                  : "text-foreground/55"
              )}
            >
              {turn.role === "user" ? "you" : "ai"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words",
                turn.role === "user"
                  ? "text-foreground/50"
                  : "text-foreground/85",
                turn.live && "text-foreground/70"
              )}
            >
              <TurnText turn={turn} />
            </span>
          </div>
        ))}
      </div>

      {notice ? (
        <p className="-mt-2 text-center text-[11.5px] text-foreground/45 leading-snug">
          {notice}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          aria-label={
            muted ? "Turn the microphone on" : "Turn the microphone off"
          }
          aria-pressed={muted}
          className={cn(
            ghostButton,
            "size-10 cursor-pointer disabled:pointer-events-none disabled:opacity-30",
            muted && "bg-foreground/[0.08] text-foreground/90"
          )}
          data-testid="voice-mute"
          disabled={!onToggleMute}
          onClick={onToggleMute}
          type="button"
        >
          {muted ? (
            <MicOffIcon className="size-4" />
          ) : (
            <MicIcon className="size-4" />
          )}
        </button>
        <button
          aria-label="End the call"
          className="flex size-10 cursor-pointer items-center justify-center rounded-full bg-red-500/90 text-white transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30 motion-reduce:transition-none"
          data-testid="voice-end"
          disabled={!onEnd}
          onClick={onEnd}
          type="button"
        >
          <PhoneOffIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
