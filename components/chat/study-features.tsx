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
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-lg bg-brand/12 py-1 pr-1.5 pl-2 font-medium text-[12.5px] text-brand-ink leading-none dark:bg-brand/18",
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
          className="-my-1 ml-0.5 grid size-5 shrink-0 place-items-center rounded-md text-brand-ink/70 transition-colors hover:bg-brand/15 hover:text-brand-ink"
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
  const handleClick = useCallback(() => onSelect(feature), [feature, onSelect]);
  return (
    <motion.button
      animate={{ opacity: 1, y: 0 }}
      aria-pressed={selected}
      className={cn(
        "group flex min-w-0 flex-col items-start gap-2 rounded-xl bg-black p-3 text-left text-white shadow-[0_1px_2px_rgb(0_0_0/0.12),0_4px_14px_-6px_rgb(0_0_0/0.35)] ring-1 ring-white/10 ring-inset transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-neutral-900 active:scale-[0.98] sm:flex-row sm:gap-2.5 sm:p-3.5",
        selected && "bg-neutral-900"
      )}
      data-testid={`feature-card-${feature.id}`}
      initial={{ opacity: 0, y: 16 }}
      onClick={handleClick}
      transition={{ delay: 0.05 * index, duration: 0.4, ease: EASE }}
      type="button"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.08] text-[#34D399] transition-colors duration-200",
          selected && "bg-[#10B981] text-black"
        )}
      >
        <Icon aria-hidden className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold text-[13px] leading-snug">
          {feature.label}
        </span>
        <span className="line-clamp-2 text-[11.5px] text-white/60 leading-snug">
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
      className="grid w-full grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-2.5"
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
