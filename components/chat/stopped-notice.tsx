"use client";

import { motion, useReducedMotion } from "framer-motion";
import { SquareIcon } from "lucide-react";

/** Shown where a reply ends when the student pressed Stop. */
export function StoppedNotice() {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
      className="flex w-fit items-center gap-2 rounded-xl border border-border/50 bg-muted/40 py-1.5 pr-3 pl-2 text-[12.5px] text-muted-foreground"
      data-testid="stopped-notice"
      initial={
        reduceMotion
          ? { opacity: 0 }
          : { filter: "blur(6px)", opacity: 0, y: 5 }
      }
      role="status"
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <span className="grid size-5 place-items-center rounded-full bg-red-500/12 text-red-500">
        <SquareIcon aria-hidden className="size-2.5 fill-current" />
      </span>
      <span>
        <span className="font-medium text-foreground/80">
          Response generation stopped.
        </span>{" "}
        <span className="hidden sm:inline">Send a message to continue.</span>
      </span>
    </motion.div>
  );
}
