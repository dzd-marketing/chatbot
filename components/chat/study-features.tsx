"use client";

import { motion } from "framer-motion";
import {
  FileDownIcon,
  LayersIcon,
  ListChecksIcon,
  type LucideIcon,
  NotebookPenIcon,
  ScrollTextIcon,
  SigmaIcon,
  XIcon,
} from "lucide-react";
import { memo, useCallback } from "react";
import {
  type StudyFeature,
  type StudyFeatureId,
  studyFeatures,
} from "@/lib/study-features";
import { cn } from "@/lib/utils";

export const FEATURE_ICONS: Record<StudyFeatureId, LucideIcon> = {
  flashcards: LayersIcon,
  notes: NotebookPenIcon,
  papers: FileDownIcon,
  quiz: ListChecksIcon,
  solve: SigmaIcon,
  summarize: ScrollTextIcon,
};

/**
 * A colour per feature (full class names so Tailwind keeps them).
 * Card tiles sit on dark grey; chips adapt to light and dark mode.
 */
const FEATURE_COLORS: Record<
  StudyFeatureId,
  { tile: string; tileSelected: string; chip: string; chipButton: string }
> = {
  flashcards: {
    chip: "bg-violet-500/12 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
    chipButton: "hover:bg-violet-500/15",
    tile: "bg-violet-400/12 text-violet-300 group-hover:bg-violet-400/22",
    tileSelected: "bg-violet-400 text-neutral-950",
  },
  notes: {
    chip: "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    chipButton: "hover:bg-emerald-500/15",
    tile: "bg-emerald-400/12 text-emerald-300 group-hover:bg-emerald-400/22",
    tileSelected: "bg-emerald-400 text-neutral-950",
  },
  papers: {
    chip: "bg-sky-500/12 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
    chipButton: "hover:bg-sky-500/15",
    tile: "bg-sky-400/12 text-sky-300 group-hover:bg-sky-400/22",
    tileSelected: "bg-sky-400 text-neutral-950",
  },
  quiz: {
    chip: "bg-amber-500/14 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    chipButton: "hover:bg-amber-500/18",
    tile: "bg-amber-400/12 text-amber-300 group-hover:bg-amber-400/22",
    tileSelected: "bg-amber-400 text-neutral-950",
  },
  solve: {
    chip: "bg-orange-500/12 text-orange-700 dark:bg-orange-400/15 dark:text-orange-300",
    chipButton: "hover:bg-orange-500/15",
    tile: "bg-orange-400/12 text-orange-300 group-hover:bg-orange-400/22",
    tileSelected: "bg-orange-400 text-neutral-950",
  },
  summarize: {
    chip: "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    chipButton: "hover:bg-rose-500/15",
    tile: "bg-rose-400/12 text-rose-300 group-hover:bg-rose-400/22",
    tileSelected: "bg-rose-400 text-neutral-950",
  },
};

/** The picked feature, shown in the input and in the sent message. */
export function FeatureChip({
  feature,
  onRemove,
  className,
}: {
  feature: StudyFeature;
  onRemove?: () => void;
  className?: string;
}) {
  const Icon = FEATURE_ICONS[feature.id];
  const colors = FEATURE_COLORS[feature.id];
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg py-1 pr-1.5 pl-2 font-medium text-[12.5px] leading-none",
        colors.chip,
        onRemove ? "" : "pr-2",
        className
      )}
      data-testid="feature-chip"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">{feature.label}</span>
      {onRemove ? (
        <button
          aria-label={`Remove ${feature.label}`}
          className={cn(
            "-my-1 ml-0.5 grid size-5 shrink-0 place-items-center rounded-md opacity-70 transition-[opacity,background-color] hover:opacity-100",
            colors.chipButton
          )}
          onClick={onRemove}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

const EASE = [0.22, 1, 0.36, 1] as const;

function FeatureCard({
  feature,
  index,
  selected,
  onSelect,
}: {
  feature: StudyFeature;
  index: number;
  selected: boolean;
  onSelect: (feature: StudyFeature) => void;
}) {
  const Icon = FEATURE_ICONS[feature.id];
  const colors = FEATURE_COLORS[feature.id];
  const handleClick = useCallback(() => onSelect(feature), [feature, onSelect]);
  return (
    <motion.button
      animate={{ opacity: 1, y: 0 }}
      aria-pressed={selected}
      className={cn(
        "group flex min-w-0 items-center gap-2 rounded-xl bg-neutral-900 p-2 text-left text-white shadow-[0_1px_2px_rgb(0_0_0/0.1),0_3px_10px_-6px_rgb(0_0_0/0.3)] ring-1 ring-white/[0.07] ring-inset transition-[transform,background-color,box-shadow] duration-200 ease-out hover:-translate-y-px hover:bg-neutral-800 hover:shadow-[0_2px_4px_rgb(0_0_0/0.12),0_8px_18px_-8px_rgb(0_0_0/0.4)] active:translate-y-0 active:scale-[0.98] sm:gap-2.5 sm:p-2.5",
        selected && "bg-neutral-800"
      )}
      data-testid={`feature-card-${feature.id}`}
      initial={{ opacity: 0, y: 16 }}
      onClick={handleClick}
      transition={{ delay: 0.05 * index, duration: 0.4, ease: EASE }}
      type="button"
    >
      <span
        className={cn(
          "grid size-7 shrink-0 place-items-center rounded-lg transition-colors duration-200 sm:size-8",
          selected ? colors.tileSelected : colors.tile
        )}
      >
        <Icon aria-hidden className="size-3.5 sm:size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold text-[12.5px] leading-tight sm:text-[13px]">
          {feature.label}
        </span>
        {/* Phones show the title only, to keep the cards compact. */}
        <span className="mt-0.5 hidden truncate text-[11px] text-white/50 leading-tight transition-colors duration-200 group-hover:text-white/75 sm:block">
          {feature.description}
        </span>
      </span>
    </motion.button>
  );
}

/** Welcome-screen grid: 2 columns on phones, 3 from small tablets up. */
function PureStudyFeatureCards({
  selectedId,
  onSelect,
}: {
  selectedId?: StudyFeatureId;
  onSelect: (feature: StudyFeature) => void;
}) {
  return (
    <div
      className="grid w-full grid-cols-2 gap-1.5 sm:grid-cols-3 sm:gap-2"
      data-testid="study-features"
    >
      {studyFeatures.map((feature, index) => (
        <FeatureCard
          feature={feature}
          index={index}
          key={feature.id}
          onSelect={onSelect}
          selected={feature.id === selectedId}
        />
      ))}
    </div>
  );
}

export const StudyFeatureCards = memo(PureStudyFeatureCards);
