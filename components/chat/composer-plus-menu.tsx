"use client";

import { AnimatePresence, motion, type Transition } from "framer-motion";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PaperclipIcon,
  PlusIcon,
  WrenchIcon,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useActiveChat } from "@/hooks/use-active-chat";
import { useChatModel } from "@/hooks/use-chat-models";
import { getReasoningOptions, type ReasoningLevel } from "@/lib/ai/models";
import { type ToolGroupId, toolGroups } from "@/lib/ai/tool-groups";
import { cn } from "@/lib/utils";
import { EffortBarsIcon, TOOL_ICONS, ToolSwitch } from "./composer-controls";

/**
 * Phones: one "+" button holds attachments, reasoning and tools. Picking
 * Reasoning or Tools slides the card over to that page, with a back button,
 * instead of opening a second menu on top.
 */

type View = "main" | "reasoning" | "tools";

const slide: Transition = { duration: 0.24, ease: [0.32, 0.72, 0, 1] };
// New pages come in from the side they were opened from.
const pageVariants = {
  center: { opacity: 1, x: 0 },
  enter: (direction: number) => ({ opacity: 0, x: direction * 28 }),
  exit: (direction: number) => ({ opacity: 0, x: direction * -28 }),
};
const resize: Transition = { duration: 0.26, ease: [0.32, 0.72, 0, 1] };

const rowClass =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.06] active:bg-foreground/[0.08] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
const iconTileClass =
  "flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.06] text-foreground/80";

function MenuHeader({
  title,
  note,
  onBack,
}: {
  title: string;
  note?: string;
  onBack: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-1 pt-1 pb-1.5">
      <button
        aria-label="Back"
        className="flex size-8 items-center justify-center rounded-full text-foreground/70 transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        data-testid="plus-menu-back"
        onClick={onBack}
        type="button"
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <span className="flex-1 font-semibold text-[13.5px] text-foreground">
        {title}
      </span>
      {note ? (
        <span className="truncate pr-2 text-[11.5px] text-muted-foreground">
          {note}
        </span>
      ) : null}
    </div>
  );
}

function ReasoningRow({
  option,
  selected,
  onSelect,
}: {
  option: { value: ReasoningLevel; label: string; description: string };
  selected: boolean;
  onSelect: (value: ReasoningLevel) => void;
}) {
  const handleClick = useCallback(
    () => onSelect(option.value),
    [onSelect, option.value]
  );
  return (
    <button
      aria-checked={selected}
      className={rowClass}
      data-testid={`plus-reasoning-${option.value}`}
      onClick={handleClick}
      role="menuitemradio"
      type="button"
    >
      <span className={cn(iconTileClass, selected && "text-brand")}>
        <EffortBarsIcon level={option.value} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[14px] text-foreground leading-tight">
          {option.label}
        </span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground leading-snug">
          {option.description}
        </span>
      </span>
      {selected ? <CheckIcon className="size-4 shrink-0 text-brand" /> : null}
    </button>
  );
}

function ToolToggleRow({
  id,
  label,
  description,
  checked,
  disabled,
  onToggle,
}: {
  id: ToolGroupId;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onToggle: (id: ToolGroupId, enabled: boolean) => void;
}) {
  const Icon = TOOL_ICONS[id];
  const handleClick = useCallback(
    () => onToggle(id, !checked),
    [checked, id, onToggle]
  );
  return (
    <button
      aria-checked={checked}
      className={rowClass}
      data-testid={`plus-tool-${id}`}
      disabled={disabled}
      onClick={handleClick}
      role="menuitemcheckbox"
      type="button"
    >
      <span
        className={cn(
          iconTileClass,
          checked && "bg-brand/10 text-brand",
          "transition-colors duration-200"
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[14px] text-foreground leading-tight">
          {label}
        </span>
        <span className="mt-0.5 block text-[12px] text-muted-foreground leading-snug">
          {description}
        </span>
      </span>
      <ToolSwitch on={checked} />
    </button>
  );
}

const noopToggle = () => undefined;

export function ComposerPlusMenu({
  onAttach,
  attachDisabled,
  attachNote,
}: {
  onAttach: () => void;
  attachDisabled: boolean;
  attachNote: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  // Radix can call the Esc handler with an older render's closure.
  const viewRef = useRef<View>("main");
  viewRef.current = view;
  const [direction, setDirection] = useState(1);

  const {
    currentModelId,
    reasoningLevel,
    setReasoningLevel,
    toolSettings,
    setToolEnabled,
  } = useActiveChat();
  const { capabilities, model } = useChatModel(currentModelId);
  const modelName = model?.name ?? "This model";

  const reasoningOptions = getReasoningOptions(model);
  const selectedReasoning =
    reasoningOptions.find((option) => option.value === reasoningLevel) ??
    reasoningOptions[0];

  const supportsTools = capabilities?.tools ?? true;
  const builtIn = capabilities?.builtInWebSearch === true;
  const enabledCount = supportsTools
    ? toolGroups.filter((group) => toolSettings[group.id]).length
    : 0;
  let toolsSummary = `${enabledCount} of ${toolGroups.length} on`;
  if (builtIn) {
    toolsSummary = "Built in";
  } else if (!supportsTools) {
    toolsSummary = "Not available";
  } else if (enabledCount === 0) {
    toolsSummary = "All off";
  }

  // The card's height follows the page being shown.
  const [pageElement, setPageElement] = useState<HTMLDivElement | null>(null);
  // The leaving page unmounts after the new one mounts: ignore its null.
  // After moving between pages, focus the new page's first item so the
  // keyboard and screen readers don't fall back to the page body.
  const navigatedRef = useRef(false);
  const handlePageRef = useCallback((element: HTMLDivElement | null) => {
    if (!element) {
      return;
    }
    setPageElement(element);
    if (navigatedRef.current) {
      navigatedRef.current = false;
      element
        .querySelector<HTMLElement>("button:not([disabled])")
        ?.focus({ preventScroll: true });
    }
  }, []);
  const [height, setHeight] = useState<number | "auto">("auto");
  useLayoutEffect(() => {
    const page = pageElement;
    if (!(open && page)) {
      return;
    }
    const measure = () => setHeight(page.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    return () => observer.disconnect();
  }, [open, pageElement]);

  const go = useCallback((next: View) => {
    navigatedRef.current = true;
    setDirection(next === "main" ? -1 : 1);
    setView(next);
  }, []);
  const goMain = useCallback(() => go("main"), [go]);
  const goReasoning = useCallback(() => go("reasoning"), [go]);
  const goTools = useCallback(() => go("tools"), [go]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) {
      setDirection(1);
      setView("main");
      setHeight("auto");
    }
  }, []);

  const handleAttach = useCallback(() => {
    setOpen(false);
    onAttach();
  }, [onAttach]);

  const handleReasoning = useCallback(
    (value: ReasoningLevel) => {
      setReasoningLevel(value);
      go("main");
    },
    [go, setReasoningLevel]
  );

  // Esc on a sub-page goes back first.
  const handleEscape = useCallback(
    (event: KeyboardEvent) => {
      if (viewRef.current !== "main") {
        event.preventDefault();
        go("main");
      }
    },
    [go]
  );

  let page: React.ReactNode;
  if (view === "reasoning") {
    page = (
      <div role="menu">
        <MenuHeader onBack={goMain} title="Reasoning" />
        {reasoningOptions.map((option) => (
          <ReasoningRow
            key={option.value}
            onSelect={handleReasoning}
            option={option}
            selected={option.value === selectedReasoning?.value}
          />
        ))}
      </div>
    );
  } else if (view === "tools") {
    page = (
      <div role="menu">
        <MenuHeader
          note={builtIn ? `${modelName} searches by itself` : toolsSummary}
          onBack={goMain}
          title="Tools"
        />
        {builtIn ? (
          <>
            <ToolToggleRow
              checked
              description="Built in: looks things up when needed"
              disabled
              id={toolGroups[0].id}
              label={toolGroups[0].label}
              onToggle={noopToggle}
            />
            <p className="px-3 pt-1 pb-2 text-[12px] text-muted-foreground leading-snug">
              Documents and other tools need a different model.
            </p>
          </>
        ) : (
          toolGroups.map((group) => (
            <ToolToggleRow
              checked={toolSettings[group.id]}
              description={group.description}
              id={group.id}
              key={group.id}
              label={group.label}
              onToggle={setToolEnabled}
            />
          ))
        )}
      </div>
    );
  } else {
    page = (
      <div role="menu">
        <button
          className={rowClass}
          data-testid="plus-attach"
          disabled={attachDisabled}
          onClick={handleAttach}
          role="menuitem"
          type="button"
        >
          <span className={iconTileClass}>
            <PaperclipIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-[14px] text-foreground leading-tight">
              Add photos & files
            </span>
            <span className="mt-0.5 block text-[12px] text-muted-foreground leading-snug">
              {attachNote}
            </span>
          </span>
        </button>

        {reasoningOptions.length > 0 && selectedReasoning ? (
          <button
            className={rowClass}
            data-testid="plus-reasoning"
            onClick={goReasoning}
            role="menuitem"
            type="button"
          >
            <span className={iconTileClass}>
              <EffortBarsIcon level={selectedReasoning.value} />
            </span>
            <span className="min-w-0 flex-1 font-medium text-[14px] text-foreground">
              Reasoning
            </span>
            <span className="text-[12.5px] text-muted-foreground">
              {selectedReasoning.label}
            </span>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ) : null}

        <button
          className={rowClass}
          data-testid="plus-tools"
          disabled={!(supportsTools || builtIn)}
          onClick={goTools}
          role="menuitem"
          type="button"
        >
          <span className={iconTileClass}>
            <WrenchIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1 font-medium text-[14px] text-foreground">
            Tools
          </span>
          <span className="text-[12.5px] text-muted-foreground">
            {toolsSummary}
          </span>
          <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <PopoverPrimitive.Root onOpenChange={handleOpenChange} open={open}>
      <PopoverPrimitive.Trigger asChild>
        <button
          aria-label={open ? "Close menu" : "Add files, reasoning and tools"}
          className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-foreground/[0.03] text-foreground/80 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.07] hover:text-foreground active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground"
          data-testid="plus-menu"
          type="button"
        >
          <PlusIcon
            className={cn(
              "size-[18px] transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              open && "rotate-45"
            )}
          />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          aria-label="Composer options"
          className="z-[400] w-[min(20rem,calc(100vw-1.5rem))] origin-(--radix-popover-content-transform-origin) overflow-hidden rounded-2xl border border-border/60 bg-card p-1.5 text-card-foreground shadow-[0_16px_40px_-12px_rgb(0_0_0/0.35),0_2px_6px_-2px_rgb(0_0_0/0.12)] outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2 duration-150"
          collisionPadding={12}
          data-testid="plus-menu-card"
          onEscapeKeyDown={handleEscape}
          side="top"
          sideOffset={10}
        >
          <motion.div
            animate={{ height }}
            className="relative overflow-hidden"
            initial={false}
            transition={resize}
          >
            <AnimatePresence
              custom={direction}
              initial={false}
              mode="popLayout"
            >
              <motion.div
                animate="center"
                custom={direction}
                exit="exit"
                initial="enter"
                key={view}
                ref={handlePageRef}
                transition={slide}
                variants={pageVariants}
              >
                {page}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
