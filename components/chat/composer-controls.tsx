"use client";

import { AnimatePresence, motion, type Transition } from "framer-motion";
import {
  CheckIcon,
  ChevronDownIcon,
  CloudSunIcon,
  FileTextIcon,
  GlobeIcon,
  LinkIcon,
  type LucideIcon,
  WrenchIcon,
} from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
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
import { useActiveChat } from "@/hooks/use-active-chat";
import { useChatModel } from "@/hooks/use-chat-models";
import {
  getReasoningOptions,
  type ReasoningLevel,
  type ReasoningOption,
} from "@/lib/ai/models";
import {
  type ToolGroup,
  type ToolGroupId,
  toolGroups,
} from "@/lib/ai/tool-groups";
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

/* -------------------------------------------------------------------------- */
/*                                   Tools                                    */
/* -------------------------------------------------------------------------- */

const TOOL_ICONS: Record<ToolGroupId, LucideIcon> = {
  documents: FileTextIcon,
  weather: CloudSunIcon,
  webFetch: LinkIcon,
  webSearch: GlobeIcon,
};

function ToolSwitch({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full transition-colors duration-200",
        on ? "bg-brand" : "bg-muted-foreground/25"
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] left-[2px] size-[14px] rounded-full bg-white shadow-sm transition-transform duration-200",
          on && "translate-x-[14px]"
        )}
      />
    </span>
  );
}

function ToolRow({
  group,
  checked,
  disabled,
  note,
  onToggle,
}: {
  group: ToolGroup;
  checked: boolean;
  disabled: boolean;
  note?: string;
  onToggle: (id: ToolGroupId, enabled: boolean) => void;
}) {
  const Icon = TOOL_ICONS[group.id];

  const handleCheckedChange = useCallback(
    (value: boolean) => onToggle(group.id, value),
    [group.id, onToggle]
  );
  // Keep the menu open so several tools can be switched in one go.
  const handleSelect = useCallback(
    (event: Event) => event.preventDefault(),
    []
  );

  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className="group flex cursor-default select-none items-center gap-2.5 rounded-lg px-2.5 py-2 outline-hidden transition-colors duration-150 focus:bg-muted/70 data-disabled:cursor-not-allowed data-disabled:opacity-55"
      data-testid={`tool-${group.id}`}
      disabled={disabled}
      onCheckedChange={handleCheckedChange}
      onSelect={handleSelect}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors duration-200",
          checked
            ? "border-brand/25 bg-brand/10 text-brand"
            : "border-border/50 text-muted-foreground"
        )}
      >
        <Icon className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[13px] text-foreground leading-tight">
          {group.label}
        </span>
        <span className="mt-0.5 block text-[11.5px] text-muted-foreground leading-snug">
          {note ?? group.description}
        </span>
      </span>
      <ToolSwitch on={checked} />
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function ToolsDropdown() {
  const { currentModelId, toolSettings, setToolEnabled } = useActiveChat();
  const { capabilities, model } = useChatModel(currentModelId);
  // Assume support until capabilities load, so the default "on" state
  // doesn't flicker.
  const supportsTools = capabilities?.tools ?? true;
  // Models with their own server-side search (DZD Learn AI) decide by
  // themselves when to search; the website's tools can't be used.
  const builtIn = capabilities?.builtInWebSearch === true;
  const modelName = model?.name ?? "This model";

  const enabledCount = supportsTools
    ? toolGroups.filter((group) => toolSettings[group.id]).length
    : 0;
  const active = builtIn || enabledCount > 0;

  if (!supportsTools && !builtIn) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            aria-disabled="true"
            aria-label="Tools are not available with this model"
            className="inline-flex h-7 shrink-0 cursor-not-allowed items-center gap-1.5 rounded-full border border-border/40 px-2 text-[12px] font-medium text-muted-foreground opacity-50 sm:px-2.5"
            data-testid="tools-selector"
            type="button"
          >
            <WrenchIcon className="size-3.5" />
            <span className="hidden sm:inline">Tools</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {modelName} can't use tools. Pick another model for web search and
          documents.
        </TooltipContent>
      </Tooltip>
    );
  }

  let summary = `${enabledCount} of ${toolGroups.length} on`;
  if (builtIn) {
    summary = "Built in";
  } else if (enabledCount === 0) {
    summary = "All off";
  }

  const headerNote = builtIn ? `${modelName} searches by itself` : summary;

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          aria-label={`Tools: ${summary}`}
          className={cn(
            "group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px] font-medium outline-hidden transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-brand/40 sm:px-2.5",
            active
              ? "border-brand/30 bg-brand/8 text-brand hover:border-brand/45"
              : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
          )}
          data-state-active={active ? "on" : "off"}
          data-testid="tools-selector"
          type="button"
        >
          <WrenchIcon className="size-3.5" />
          <span className="hidden sm:inline">Tools</span>
          {!builtIn && enabledCount > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-brand-foreground tabular-nums">
              {enabledCount}
            </span>
          ) : null}
          <ChevronDownIcon className="size-3 opacity-70 transition-transform duration-200 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="start"
          aria-label="Tools"
          className="z-[400] w-[min(18rem,calc(100vw-1.5rem))] origin-(--radix-dropdown-menu-content-transform-origin) rounded-xl border border-border/60 bg-card p-1 text-card-foreground shadow-[0_12px_32px_-12px_rgb(0_0_0/0.28),0_2px_6px_-2px_rgb(0_0_0/0.12)] data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-100"
          collisionPadding={VIEWPORT_MARGIN}
          side="top"
          sideOffset={PANEL_OFFSET}
        >
          <div className="flex items-baseline justify-between gap-3 px-2.5 pt-1.5 pb-1">
            <span className="font-semibold text-[12px] text-foreground">
              Tools
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {headerNote}
            </span>
          </div>
          {builtIn ? (
            <BuiltInSearchRow />
          ) : (
            toolGroups.map((group) => (
              <ToolRow
                checked={toolSettings[group.id]}
                disabled={false}
                group={group}
                key={group.id}
                onToggle={setToolEnabled}
              />
            ))
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const noopToggle = () => undefined;

/** DZD Learn AI: its server searches the web by itself; nothing to switch. */
function BuiltInSearchRow() {
  return (
    <>
      <ToolRow
        checked
        disabled
        group={toolGroups[0]}
        note="Built in: looks things up when needed"
        onToggle={noopToggle}
      />
      <p className="px-2.5 pt-1 pb-1.5 text-[11px] text-muted-foreground leading-snug">
        Documents and other tools need a different model.
      </p>
    </>
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
  // Includes NVIDIA models, so the control follows the selected model.
  const { model } = useChatModel(currentModelId);
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
