"use client";

import { motion, useReducedMotion } from "framer-motion";
import { CornerDownRightIcon } from "lucide-react";
import { memo, useCallback } from "react";
import { useActiveChat } from "@/hooks/use-active-chat";
import { Suggestion, Suggestions } from "../ai-elements/suggestion";

const EASE = [0.22, 1, 0.36, 1] as const;

function PureFollowUpSuggestions({ suggestions }: { suggestions: string[] }) {
  const { sendMessage, status } = useActiveChat();
  const reduceMotion = useReducedMotion();

  const handleClick = useCallback(
    (suggestion: string) => {
      if (status !== "ready") {
        return;
      }
      sendMessage({
        parts: [{ text: suggestion, type: "text" }],
        role: "user",
      });
    },
    [sendMessage, status]
  );

  const hidden = reduceMotion
    ? { opacity: 0 }
    : { filter: "blur(6px)", opacity: 0, y: 5 };
  const shown = reduceMotion
    ? { opacity: 1 }
    : { filter: "blur(0px)", opacity: 1, y: 0 };

  return (
    <nav
      aria-label="Suggested follow-up questions"
      className="-mt-0.5 flex min-w-0 items-center gap-2"
      data-testid="follow-up-suggestions"
    >
      <CornerDownRightIcon
        aria-hidden="true"
        className="size-3.5 shrink-0 text-muted-foreground/60"
      />
      <div className="min-w-0 flex-1 [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">
        <Suggestions className="pr-6 pb-0.5">
          {suggestions.map((suggestion, index) => (
            <motion.div
              animate={shown}
              initial={hidden}
              key={suggestion}
              transition={{
                delay: reduceMotion ? 0 : 0.08 * index,
                duration: reduceMotion ? 0.15 : 0.5,
                ease: EASE,
              }}
            >
              <Suggestion
                className="h-7 border-border/60 bg-card/40 px-3 text-[12px] font-normal text-muted-foreground shadow-none transition-colors hover:border-brand/60 hover:bg-brand/5 hover:text-foreground"
                onClick={handleClick}
                suggestion={suggestion}
              />
            </motion.div>
          ))}
        </Suggestions>
      </div>
    </nav>
  );
}

export const FollowUpSuggestions = memo(
  PureFollowUpSuggestions,
  (prev, next) =>
    prev.suggestions.length === next.suggestions.length &&
    prev.suggestions.every((s, i) => s === next.suggestions[i])
);
