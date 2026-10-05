"use client";

import { AnimatePresence, motion, type Transition } from "framer-motion";
import { CheckIcon, ChevronDownIcon, GlobeIcon } from "lucide-react";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import useSWR from "swr";
import { useActiveChat } from "@/hooks/use-active-chat";
import {
  chatModels,
  getReasoningOptions,
  type ModelCapabilities,
  type ReasoningLevel,
  type ReasoningOption,
} from "@/lib/ai/models";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

const panelSpring: Transition = {
  damping: 34,
  mass: 0.72,
  stiffness: 420,
  type: "spring",
};

const VIEWPORT_MARGIN = 12;
const PANEL_OFFSET = 8;

/** Shares the /api/models request (and SWR cache) with the model selector. */
function useModelCapabilities() {
  const { data } = useSWR(
    `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/models`,
    (url: string) => fetch(url).then((r) => r.json()),
    { dedupingInterval: 3_600_000, revalidateOnFocus: false }
  );
  return (data?.capabilities ?? data) as
    | Record<string, ModelCapabilities>
    | undefined;
}

/* -------------------------------------------------------------------------- */
/*                                Web search                                  */
/* -------------------------------------------------------------------------- */

export function WebSearchToggle() {
  const { currentModelId, webSearchEnabled, setWebSearchEnabled } =
    useActiveChat();
  const capabilities = useModelCapabilities();
  // Assume support until capabilities load, so the default "on" state
  // doesn't flicker.
  const supportsTools = capabilities?.[currentModelId]?.tools ?? true;
  const active = webSearchEnabled && supportsTools;

  const handleClick = useCallback(() => {
    if (!supportsTools) {
      return;
    }
    setWebSearchEnabled(!webSearchEnabled);
  }, [setWebSearchEnabled, supportsTools, webSearchEnabled]);

  let hint = "Web search is off";
  if (!supportsTools) {
    hint = "This model can't search the web";
  } else if (active) {
    hint = "Web search is on: DZD AI can look things up and cite sources";
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-disabled={!supportsTools}
          aria-label="Web search"
          aria-pressed={active}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium transition-colors duration-200 sm:px-2.5",
            active
              ? "border-brand/30 bg-brand/8 text-brand hover:border-brand/45"
              : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground",
            !supportsTools &&
              "cursor-not-allowed opacity-50 hover:border-border/40 hover:text-muted-foreground"
          )}
          data-state={active ? "on" : "off"}
          data-testid="web-search-toggle"
          onClick={handleClick}
          type="button"
        >
          <GlobeIcon className="size-3.5" />
          <span className="hidden sm:inline">Search</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*                              Effort bars icon                              */
/* -------------------------------------------------------------------------- */

const BAR_X = [1.5, 5.75, 10] as const;
const BAR_WIDTH = 2.5;
const BAR_BOTTOM = 12.5;

const barHeights: Record<"low" | "medium" | "high", [number, number, number]> =
  {
    high: [4.5, 7.5, 10.5],
    low: [3.25, 4.75, 0],
    medium: [4.5, 7.5, 0],
  };

function toBarLevel(level: ReasoningLevel): keyof typeof barHeights {
  return level === "off" ? "low" : level;
}

export function EffortBarsIcon({
  level,
  className,
}: {
  level: ReasoningLevel;
  className?: string;
}) {
  const heights = barHeights[toBarLevel(level)];

  return (
    <svg
      aria-hidden="true"
      className={cn("size-3.5", className)}
      fill="currentColor"
      viewBox="0 0 14 14"
    >
      {BAR_X.map((x, index) => {
        const height = heights[index];
        return (
          <motion.rect
            animate={{
              height: Math.max(height, 0.01),
              opacity: height > 0 ? 1 : 0,
              y: BAR_BOTTOM - height,
            }}
            initial={false}
            key={x}
            rx={1}
            transition={panelSpring}
            width={BAR_WIDTH}
            x={x}
          />
        );
      })}
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/*                             Reasoning dropdown                             */
/* -------------------------------------------------------------------------- */

type ReasoningOptionItemProps = {
  option: ReasoningOption;
  isSelected: boolean;
  isHighlighted: boolean;
  highlightId: string;
  onHighlight: (value: ReasoningLevel | null) => void;
  onSelect: (value: ReasoningLevel) => void;
};

function ReasoningOptionItem({
  option,
  isSelected,
  isHighlighted,
  highlightId,
  onHighlight,
  onSelect,
}: ReasoningOptionItemProps) {
  const handleClick = useCallback(
    () => onSelect(option.value),
    [onSelect, option.value]
  );
  const handleHighlight = useCallback(
    () => onHighlight(option.value),
    [onHighlight, option.value]
  );
  const handleBlur = useCallback(() => onHighlight(null), [onHighlight]);

  return (
    <button
      aria-checked={isSelected}
      className="relative flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none"
      onBlur={handleBlur}
      onClick={handleClick}
      onFocus={handleHighlight}
      onMouseEnter={handleHighlight}
      role="menuitemradio"
      type="button"
    >
      {isHighlighted ? (
        <motion.span
          className="absolute inset-0 rounded-lg bg-accent/65"
          layoutId={highlightId}
          transition={panelSpring}
        />
      ) : null}
      <EffortBarsIcon
        className={cn(
          "relative mt-0.5 shrink-0",
          isSelected ? "text-brand" : "text-muted-foreground"
        )}
        level={option.value}
      />
      <span className="relative min-w-0 flex-1">
        <span className="block font-medium text-[13px] text-foreground leading-tight">
          {option.label}
        </span>
        <span className="mt-0.5 block text-[11.5px] text-muted-foreground leading-snug">
          {option.description}
        </span>
      </span>
      {isSelected ? (
        <CheckIcon className="relative mt-0.5 size-3.5 shrink-0 text-brand" />
      ) : null}
    </button>
  );
}

type PanelPosition = {
  left: number;
  placement: "top" | "bottom";
  top?: number;
  bottom?: number;
};

export function ReasoningDropdown() {
  const { currentModelId, reasoningLevel, setReasoningLevel } = useActiveChat();
  const model = chatModels.find((item) => item.id === currentModelId);
  const options = getReasoningOptions(model);
  const selected =
    options.find((option) => option.value === reasoningLevel) ?? options[0];

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const [highlighted, setHighlighted] = useState<ReasoningLevel | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const highlightId = useId();

  useEffect(() => {
    setMounted(true);
  }, []);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    setHighlighted(null);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const panelHeight = panelRef.current?.offsetHeight ?? 180;
    const panelWidth =
      panelRef.current?.offsetWidth ??
      Math.min(232, window.innerWidth - VIEWPORT_MARGIN * 2);
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
    const placement =
      spaceAbove >= panelHeight + PANEL_OFFSET || spaceAbove > spaceBelow
        ? "top"
        : "bottom";
    const left = Math.min(
      Math.max(rect.left, VIEWPORT_MARGIN),
      window.innerWidth - panelWidth - VIEWPORT_MARGIN
    );

    setPosition(
      placement === "top"
        ? {
            bottom: window.innerHeight - rect.top + PANEL_OFFSET,
            left,
            placement,
          }
        : { left, placement, top: rect.bottom + PANEL_OFFSET }
    );
  }, []);

  useLayoutEffect(() => {
    if (open) {
      updatePosition();
    }
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      close(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    // Move focus to the selected option once the panel is in the DOM.
    const frame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
        ?.focus();
    });

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, close, updatePosition]);

  // Close if the model changes to one without a reasoning control.
  useEffect(() => {
    if (options.length === 0 && open) {
      setOpen(false);
    }
  }, [options.length, open]);

  const handleMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]'
        ) ?? []
      );
      if (items.length === 0) {
        return;
      }
      const index = items.indexOf(document.activeElement as HTMLButtonElement);

      let next: number | null = null;
      if (event.key === "ArrowDown") {
        next = (index + 1) % items.length;
      } else if (event.key === "ArrowUp") {
        next = (index - 1 + items.length) % items.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = items.length - 1;
      } else if (event.key === "Tab") {
        close(false);
        return;
      }

      if (next !== null) {
        event.preventDefault();
        items[next]?.focus();
      }
    },
    [close]
  );

  const handleSelect = useCallback(
    (value: ReasoningLevel) => {
      setReasoningLevel(value);
      close(true);
    },
    [close, setReasoningLevel]
  );

  const handleTriggerClick = useCallback(() => {
    if (open) {
      close(false);
    } else {
      setOpen(true);
    }
  }, [close, open]);

  const handlePanelMouseLeave = useCallback(() => setHighlighted(null), []);

  if (!selected || !reasoningLevel) {
    return null;
  }

  return (
    <>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Reasoning: ${selected.label}`}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2 text-[12px] text-muted-foreground transition-colors duration-200 hover:bg-muted/70 hover:text-foreground",
          open && "bg-muted/70 text-foreground"
        )}
        data-testid="reasoning-selector"
        onClick={handleTriggerClick}
        ref={triggerRef}
        type="button"
      >
        <EffortBarsIcon level={selected.value} />
        <span className="hidden sm:inline">{selected.label}</span>
        <ChevronDownIcon
          className={cn(
            "size-3 opacity-70 transition-transform duration-200",
            open && "rotate-180"
          )}
        />
      </button>

      {mounted
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  aria-label="Reasoning mode"
                  className="fixed z-[400] w-[min(14.5rem,calc(100vw-1.5rem))] rounded-xl border border-border/60 bg-card p-1 text-card-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.28),0_2px_6px_-2px_rgb(0_0_0/0.12)]"
                  exit={{
                    opacity: 0,
                    scale: 0.98,
                    transition: { duration: 0.12 },
                    y: position?.placement === "bottom" ? -4 : 4,
                  }}
                  id={menuId}
                  initial={{
                    opacity: 0,
                    scale: 0.98,
                    y: position?.placement === "bottom" ? -6 : 6,
                  }}
                  onKeyDown={handleMenuKeyDown}
                  onMouseLeave={handlePanelMouseLeave}
                  ref={panelRef}
                  role="menu"
                  style={{
                    bottom: position?.bottom,
                    left: position?.left ?? -9999,
                    top: position?.top,
                    transformOrigin:
                      position?.placement === "bottom"
                        ? "top left"
                        : "bottom left",
                  }}
                  transition={panelSpring}
                >
                  <div className="px-2.5 pt-1.5 pb-1 font-medium text-[11px] text-muted-foreground">
                    Reasoning
                  </div>
                  {options.map((option) => (
                    <ReasoningOptionItem
                      highlightId={highlightId}
                      isHighlighted={highlighted === option.value}
                      isSelected={option.value === selected.value}
                      key={option.value}
                      onHighlight={setHighlighted}
                      onSelect={handleSelect}
                      option={option}
                    />
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body
          )
        : null}
    </>
  );
}
