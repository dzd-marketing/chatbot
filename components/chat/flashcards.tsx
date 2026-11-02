"use client";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  LayersIcon,
  RotateCcwIcon,
  ShuffleIcon,
} from "lucide-react";
import { memo, useCallback, useState } from "react";
import { toast } from "sonner";
import type { Flashcard } from "@/lib/ai/tools/study";
import { downloadWord } from "@/lib/export/download";
import { cn } from "@/lib/utils";
import { StudyText } from "./study-text";

function deckMarkdown(title: string, cards: Flashcard[]) {
  const cell = (text: string) =>
    text.replace(/\|/g, "\\|").replace(/\n+/g, " ");
  return `# ${title}\n\n| # | Front | Back |\n| --- | --- | --- |\n${cards
    .map(
      (card, index) =>
        `| ${index + 1} | ${cell(card.front)} | ${cell(card.back)} |`
    )
    .join("\n")}\n`;
}

function shuffled<T>(items: T[]) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function FlashcardsSkeleton({
  title,
  count,
}: {
  title?: string;
  count: number;
}) {
  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <LayersIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm">
            {title || "Creating your flashcards"}
          </div>
          <div className="text-muted-foreground text-xs">
            {count > 0 ? `Writing card ${count}…` : "Getting ready…"}
          </div>
        </div>
      </div>
      <div className="px-4 pb-4">
        <div className="h-48 animate-pulse rounded-2xl bg-muted-foreground/8" />
      </div>
    </div>
  );
}

function PureFlashcards({
  title,
  cards,
}: {
  title: string;
  cards: Flashcard[];
}) {
  /** Card indexes in the current order (all, shuffled, or to review). */
  const [order, setOrder] = useState<number[]>(() =>
    cards.map((_, index) => index)
  );
  const [position, setPosition] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(() => new Set());
  const [finished, setFinished] = useState(false);

  const cardIndex = order[position];
  const card = cards[cardIndex];
  const knownInRound = order.filter((index) => known.has(index)).length;

  const go = useCallback(
    (nextPosition: number) => {
      if (nextPosition >= order.length) {
        setFinished(true);
        return;
      }
      setFlipped(false);
      setPosition(Math.max(0, nextPosition));
    },
    [order.length]
  );

  const flip = useCallback(() => setFlipped((value) => !value), []);
  const previous = useCallback(() => go(position - 1), [go, position]);
  const next = useCallback(() => go(position + 1), [go, position]);

  const mark = useCallback(
    (isKnown: boolean) => {
      setKnown((current) => {
        const updated = new Set(current);
        if (isKnown) {
          updated.add(cardIndex);
        } else {
          updated.delete(cardIndex);
        }
        return updated;
      });
      go(position + 1);
    },
    [cardIndex, go, position]
  );
  const markKnown = useCallback(() => mark(true), [mark]);
  const markAgain = useCallback(() => mark(false), [mark]);

  const startRound = useCallback((indexes: number[]) => {
    setOrder(indexes);
    setPosition(0);
    setFlipped(false);
    setFinished(false);
  }, []);

  const shuffle = useCallback(
    () => startRound(shuffled(order)),
    [order, startRound]
  );
  const restart = useCallback(() => {
    setKnown(new Set());
    startRound(cards.map((_, index) => index));
  }, [cards, startRound]);
  const reviewUnknown = useCallback(
    () => startRound(order.filter((index) => !known.has(index))),
    [known, order, startRound]
  );

  const download = useCallback(async () => {
    try {
      await downloadWord(title, deckMarkdown(title, cards));
    } catch {
      toast.error("Couldn't create the Word file. Please try again.");
    }
  }, [cards, title]);

  if (cards.length === 0) {
    return null;
  }

  const iconButton =
    "flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

  return (
    <div className="w-full max-w-[560px] overflow-hidden rounded-2xl border border-border/50 bg-card shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          <LayersIcon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-[15px]">{title}</div>
          <div className="text-muted-foreground text-xs">
            {finished
              ? "Round complete"
              : `Card ${position + 1} of ${order.length} · ${known.size} known`}
          </div>
        </div>
        <button
          aria-label="Shuffle cards"
          className={iconButton}
          disabled={finished || order.length < 2}
          onClick={shuffle}
          title="Shuffle"
          type="button"
        >
          <ShuffleIcon className="size-4" />
        </button>
        <button
          aria-label="Download flashcards as Word"
          className={`${iconButton} embed:hidden`}
          onClick={download}
          title="Download (Word)"
          type="button"
        >
          <DownloadIcon className="size-4" />
        </button>
      </div>

      {finished ? (
        <div className="flex flex-col items-center px-5 pt-4 pb-7 text-center">
          <div className="font-bold text-4xl tracking-tight">
            {knownInRound}
            <span className="text-muted-foreground text-2xl">
              /{order.length}
            </span>
          </div>
          <p className="mt-2 text-muted-foreground text-sm">
            {knownInRound === order.length
              ? "You know every card in this round. Well done!"
              : "cards known. Review the rest until they stick."}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {knownInRound < order.length ? (
              <button
                className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-4 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90"
                onClick={reviewUnknown}
                type="button"
              >
                <RotateCcwIcon className="size-3.5" />
                Review {order.length - knownInRound} again
              </button>
            ) : null}
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border/60 px-4 font-medium text-sm transition-colors hover:bg-muted"
              onClick={restart}
              type="button"
            >
              Start over
            </button>
          </div>
        </div>
      ) : (
        <div className="px-4 pb-4">
          <button
            aria-label={flipped ? "Show the front" : "Show the answer"}
            className="block w-full text-left perspective-[1200px]"
            onClick={flip}
            type="button"
          >
            <div
              className={cn(
                "grid transition-transform duration-500 ease-out transform-3d motion-reduce:transition-none",
                flipped && "rotate-y-180"
              )}
            >
              <div className="flex min-h-48 flex-col rounded-2xl border border-border/60 bg-gradient-to-br from-muted/40 to-muted px-5 py-4 backface-hidden [grid-area:1/1]">
                <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                  Front
                </span>
                <div className="flex flex-1 items-center justify-center py-3 text-center">
                  <StudyText className="font-semibold text-lg leading-snug">
                    {card.front}
                  </StudyText>
                </div>
                <span className="text-center text-[11px] text-muted-foreground">
                  Tap to flip
                </span>
              </div>
              <div className="flex min-h-48 rotate-y-180 flex-col rounded-2xl border border-primary/30 bg-primary/6 px-5 py-4 backface-hidden [grid-area:1/1]">
                <span className="font-medium text-[11px] text-primary uppercase tracking-wider">
                  Back
                </span>
                <div className="flex flex-1 items-center justify-center py-3 text-center">
                  <StudyText className="text-[15px] leading-relaxed">
                    {card.back}
                  </StudyText>
                </div>
              </div>
            </div>
          </button>

          <div className="mt-3.5 flex items-center justify-between gap-2">
            <button
              aria-label="Previous card"
              className={iconButton}
              disabled={position === 0}
              onClick={previous}
              type="button"
            >
              <ChevronLeftIcon className="size-4" />
            </button>
            {flipped ? (
              <div className="flex gap-2">
                <button
                  className="inline-flex h-9 items-center rounded-xl border border-border/60 px-4 font-medium text-sm transition-colors hover:bg-muted"
                  onClick={markAgain}
                  type="button"
                >
                  Again
                </button>
                <button
                  className="inline-flex h-9 items-center rounded-xl bg-primary px-4 font-medium text-primary-foreground text-sm transition-opacity hover:opacity-90"
                  onClick={markKnown}
                  type="button"
                >
                  Know it
                </button>
              </div>
            ) : (
              <button
                className="inline-flex h-9 items-center rounded-xl border border-border/60 px-5 font-medium text-sm transition-colors hover:bg-muted"
                onClick={flip}
                type="button"
              >
                Show answer
              </button>
            )}
            <button
              aria-label="Next card"
              className={iconButton}
              onClick={next}
              type="button"
            >
              <ChevronRightIcon className="size-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const Flashcards = memo(PureFlashcards);
