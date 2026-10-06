"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckIcon, ChevronDownIcon, MicIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  VOICE_LANGUAGES,
  type VoiceLanguage,
  type VoiceState,
} from "@/hooks/use-voice-recorder";
import { cn } from "@/lib/utils";

const EASE = [0.32, 0.72, 0, 1] as const;

/* ---------------------------------------------------------------- waveform */

const BAR_WIDTH = 3;
const BAR_GAP = 2.5;
const STEP = BAR_WIDTH + BAR_GAP;
/** A new bar every SAMPLE_MS; the wave scrolls smoothly in between. */
const SAMPLE_MS = 55;
const MIN_BAR = 2.5;

/**
 * Scrolling bar waveform drawn on a canvas: the newest bar enters on the
 * right with the current loudness, older bars drift left and fade out.
 */
function VoiceWaveform({
  getLevel,
  className,
}: {
  getLevel: () => number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getLevelRef = useRef(getLevel);
  getLevelRef.current = getLevel;

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!(canvas && context)) {
      return;
    }

    let width = 0;
    let height = 0;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let colors = { brand: "", foreground: "" };
    const readColors = () => {
      const foreground = getComputedStyle(canvas).color;
      const brand =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--brand")
          .trim() || foreground;
      colors = { brand, foreground };
    };
    readColors();

    // Bar heights 0..1, newest last. Starts as a quiet baseline.
    const bars: number[] = new Array(160).fill(0);
    let peak = 0;
    let displayed = 0;
    let lastSample = performance.now();
    let frame = 0;
    let frameCount = 0;

    const draw = (now: number) => {
      frameCount += 1;
      if (frameCount % 30 === 0) {
        readColors(); // follows theme changes
      }

      // Fast attack, slower release, so syllables "pop".
      const level = Math.min(1, Math.max(0, getLevelRef.current()));
      displayed += (level - displayed) * (level > displayed ? 0.55 : 0.18);
      peak = Math.max(peak, displayed);

      while (now - lastSample >= SAMPLE_MS) {
        bars.push(peak);
        bars.shift();
        peak = displayed;
        lastSample += SAMPLE_MS;
      }
      if (now - lastSample > SAMPLE_MS * 4) {
        lastSample = now; // tab was hidden
      }

      context.clearRect(0, 0, width, height);
      const gradient = context.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, colors.foreground);
      gradient.addColorStop(0.7, colors.foreground);
      gradient.addColorStop(1, colors.brand);
      context.fillStyle = gradient;

      const scroll = ((now - lastSample) / SAMPLE_MS) * STEP;
      const middle = height / 2;
      const maxBar = height - 4;
      const visible = Math.ceil(width / STEP) + 2;
      for (let index = 0; index < visible; index += 1) {
        const value = bars.at(-1 - index) ?? 0;
        // Newest bar sits at the right edge; the live level grows into it.
        const x = width - BAR_WIDTH - index * STEP - (STEP - scroll);
        if (x < -BAR_WIDTH) {
          break;
        }
        const live = index === 0 ? Math.max(value, displayed) : value;
        const barHeight = MIN_BAR + live ** 0.85 * (maxBar - MIN_BAR);
        // Fade out towards the left edge.
        context.globalAlpha = Math.min(1, Math.max(0, x / (width * 0.35)));
        context.beginPath();
        if (typeof context.roundRect === "function") {
          context.roundRect(
            x,
            middle - barHeight / 2,
            BAR_WIDTH,
            barHeight,
            BAR_WIDTH / 2
          );
        } else {
          context.rect(x, middle - barHeight / 2, BAR_WIDTH, barHeight);
        }
        context.fill();
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div aria-hidden="true" className={cn("h-11 w-full", className)}>
      <canvas
        className="block h-full w-full text-foreground/85"
        ref={canvasRef}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

/**
 * Covers the textarea while listening: live transcript (words still being
 * recognised are lighter) above the waveform.
 */
export function VoicePanel({
  getLevel,
  state,
  transcript,
}: {
  getLevel: () => number;
  state: VoiceState;
  transcript: { final: string; interim: string };
}) {
  const empty = !(transcript.final || transcript.interim);

  return (
    <motion.div
      animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
      className="absolute inset-0 z-10 flex flex-col justify-between overflow-hidden rounded-t-2xl px-4 pt-3.5 pb-1"
      data-testid="voice-panel"
      exit={{ filter: "blur(6px)", opacity: 0, y: 4 }}
      initial={{ filter: "blur(6px)", opacity: 0, y: 4 }}
      transition={{ duration: 0.35, ease: EASE }}
    >
      <div
        aria-live="polite"
        className="flex max-h-[3.4rem] min-h-6 flex-col justify-end overflow-hidden text-[14px] leading-relaxed"
      >
        {empty ? (
          <span className="dzd-voice-shimmer select-none">
            {state === "finishing" ? "Finishing…" : "Listening… start speaking"}
          </span>
        ) : (
          <p className="break-words">
            <span className="text-foreground">{transcript.final}</span>
            {transcript.interim ? (
              <span className="text-muted-foreground/70">
                {transcript.final ? " " : ""}
                {transcript.interim}
              </span>
            ) : null}
          </p>
        )}
      </div>
      <VoiceWaveform
        className={cn(
          "transition-opacity duration-300",
          state === "finishing" && "opacity-40"
        )}
        getLevel={getLevel}
      />
    </motion.div>
  );
}

/* --------------------------------------------------------------- controls */

function useElapsed(startedAt: number, running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      return;
    }
    const tick = () =>
      setElapsed(Math.max(0, (performance.now() - startedAt) / 1000));
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return elapsed;
}

function formatElapsed(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function VoiceLanguageMenu({
  lang,
  onLangChange,
}: {
  lang: VoiceLanguage;
  onLangChange: (lang: VoiceLanguage) => void;
}) {
  const handleValueChange = useCallback(
    (value: string) => onLangChange(value as VoiceLanguage),
    [onLangChange]
  );
  const current =
    VOICE_LANGUAGES.find((option) => option.id === lang) ?? VOICE_LANGUAGES[0];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label={`Voice language: ${current.label}`}
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          type="button"
        >
          {current.short}
          <ChevronDownIcon className="size-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-40" side="top">
        <DropdownMenuLabel className="text-[11px] text-muted-foreground">
          I'm speaking in
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup onValueChange={handleValueChange} value={lang}>
          {VOICE_LANGUAGES.map((option) => (
            <DropdownMenuRadioItem
              className="text-[13px]"
              key={option.id}
              value={option.id}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Footer while listening: recording dot, timer, language, cancel and send. */
export function VoiceControls({
  lang,
  onCancel,
  onLangChange,
  onSend,
  startedAt,
  state,
}: {
  lang: VoiceLanguage;
  onCancel: () => void;
  onLangChange: (lang: VoiceLanguage) => void;
  onSend: () => void;
  startedAt: number;
  state: VoiceState;
}) {
  const listening = state === "listening";
  const elapsed = useElapsed(startedAt, listening);

  // Esc cancels, Enter sends (unless a menu is open and handling keys).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector("[role=menu]")) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSend();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onSend]);

  return (
    <div className="flex w-full items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <span className="relative ml-1.5 flex size-2.5">
          {listening ? (
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500/60" />
          ) : null}
          <span
            className={cn(
              "relative inline-flex size-2.5 rounded-full transition-colors",
              listening ? "bg-red-500" : "bg-muted-foreground/50"
            )}
          />
        </span>
        <span className="min-w-9 font-medium text-[12.5px] text-foreground/85 tabular-nums">
          {formatElapsed(elapsed)}
        </span>
        <VoiceLanguageMenu lang={lang} onLangChange={onLangChange} />
      </div>

      <div className="flex items-center gap-1.5">
        <motion.button
          aria-label="Cancel voice message"
          className="flex h-7 w-7 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          data-testid="voice-cancel"
          onClick={onCancel}
          type="button"
          whileTap={{ scale: 0.9 }}
        >
          <XIcon className="size-4" />
        </motion.button>
        <motion.button
          aria-label="Send voice message"
          className="relative flex h-7 w-7 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-default"
          data-testid="voice-send"
          disabled={!listening}
          onClick={onSend}
          type="button"
          whileTap={{ scale: 0.9 }}
        >
          {listening ? (
            <span className="dzd-voice-ring pointer-events-none absolute inset-0 rounded-xl" />
          ) : null}
          <AnimatePresence initial={false} mode="wait">
            {listening ? (
              <motion.span
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.6 }}
                initial={{ opacity: 0, scale: 0.6 }}
                key="check"
                transition={{ duration: 0.18 }}
              >
                <CheckIcon className="size-4" strokeWidth={2.5} />
              </motion.span>
            ) : (
              <motion.span
                animate={{ opacity: 1, rotate: 360 }}
                className="block size-3.5 rounded-full border-2 border-current border-t-transparent"
                initial={{ opacity: 0 }}
                key="spinner"
                transition={{
                  opacity: { duration: 0.18 },
                  rotate: {
                    duration: 0.8,
                    ease: "linear",
                    repeat: Number.POSITIVE_INFINITY,
                  },
                }}
              />
            )}
          </AnimatePresence>
        </motion.button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- mic button */

export function MicButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      aria-label="Speak your message"
      className="flex h-7 w-7 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      data-testid="voice-button"
      disabled={disabled}
      onClick={onClick}
      title="Speak your message"
      type="button"
      whileTap={disabled ? undefined : { scale: 0.88 }}
    >
      <MicIcon className="size-4" />
    </motion.button>
  );
}
