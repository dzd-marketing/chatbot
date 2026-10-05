"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { memo, useEffect, useState } from "react";

/** Rotating hints shown in the empty message input. */
export const PLACEHOLDER_HINTS = [
  "Ask DZD AI anything…",
  "Explain Newton's laws with A/L examples…",
  "ඕනෑම පාඩමක් ගැන සිංහලෙන් අහන්න…",
  "Make me an O/L Maths revision plan…",
  "எந்தப் பாடம் பற்றியும் தமிழில் கேளுங்கள்…",
] as const;

const HOLD_MS = 3800;
const WORD_STAGGER_S = 0.06;
const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Overlay that sits on top of the empty textarea and cycles through hints.
 * Each hint blurs in word by word (blur 6px, 5px rise, fade, 0.5s, like the
 * streaming replies); the old hint blurs out before the next one arrives.
 * Purely decorative (aria-hidden): the textarea carries its own aria-label.
 * Under reduced motion, hints swap with a plain short fade.
 */
function PureAnimatedPlaceholder({
  className,
  hints = PLACEHOLDER_HINTS,
}: {
  className?: string;
  hints?: readonly string[];
}) {
  const [index, setIndex] = useState(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (hints.length < 2) {
      return;
    }
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setIndex((i) => (i + 1) % hints.length);
      }
    }, HOLD_MS);
    return () => window.clearInterval(timer);
  }, [hints.length]);

  const hint = hints[index] ?? "";
  const words = hint.split(" ");

  const hidden = reduceMotion
    ? { opacity: 0 }
    : { filter: "blur(6px)", opacity: 0, y: 5 };
  const shown = reduceMotion
    ? { opacity: 1 }
    : { filter: "blur(0px)", opacity: 1, y: 0 };
  const gone = reduceMotion
    ? { opacity: 0 }
    : { filter: "blur(6px)", opacity: 0, y: -4 };

  return (
    <div
      aria-hidden="true"
      className={className}
      data-testid="animated-placeholder"
    >
      <AnimatePresence initial={false} mode="wait">
        <motion.span
          animate="shown"
          className="block"
          exit="gone"
          initial="hidden"
          key={hint}
          transition={{ staggerChildren: reduceMotion ? 0 : WORD_STAGGER_S }}
          variants={{
            gone: {
              transition: {
                duration: 0.25,
                staggerChildren: reduceMotion ? 0 : 0.02,
              },
            },
            hidden: {},
            shown: {},
          }}
        >
          {words.map((word, i) => (
            <span key={`${word}-${i.toString()}`}>
              <motion.span
                className="inline-block"
                transition={{
                  duration: reduceMotion ? 0.15 : 0.5,
                  ease: EASE,
                }}
                variants={{
                  gone: { ...gone, transition: { duration: 0.25 } },
                  hidden,
                  shown,
                }}
              >
                {word}
              </motion.span>
              {i < words.length - 1 ? " " : null}
            </span>
          ))}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export const AnimatedPlaceholder = memo(PureAnimatedPlaceholder);
