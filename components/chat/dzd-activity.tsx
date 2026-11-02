"use client";

import {
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  type LucideIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import type { DzdActivityData } from "@/lib/types";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "../ai-elements/chain-of-thought";
import { Shimmer } from "../ai-elements/shimmer";
import { useResearchDisclosure } from "./web-research";

type ToolKind = "search" | "page" | "other";

const SEARCH_PATTERN = /search/i;
const PAGE_PATTERN = /fetch|read|url|page|open|brows/i;

function toolKind(tool: string): ToolKind {
  if (SEARCH_PATTERN.test(tool)) {
    return "search";
  }
  if (PAGE_PATTERN.test(tool)) {
    return "page";
  }
  return "other";
}

const kindIcon: Record<ToolKind, LucideIcon> = {
  other: WrenchIcon,
  page: FileTextIcon,
  search: SearchIcon,
};

function progressIcon(text: string): LucideIcon {
  if (SEARCH_PATTERN.test(text)) {
    return SearchIcon;
  }
  if (PAGE_PATTERN.test(text)) {
    return FileTextIcon;
  }
  return BrainIcon;
}

function formatDuration(ms: number | undefined) {
  if (ms === undefined) {
    return;
  }
  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function toolLabel(tool: string) {
  const kind = toolKind(tool);
  if (kind === "search") {
    return "Searched the web";
  }
  if (kind === "page") {
    return "Read a web page";
  }
  return `Used ${tool.replace(/_/g, " ")}`;
}

function summarize(data: DzdActivityData) {
  const steps = data.toolSteps ?? [];
  const searches = steps.filter((s) => toolKind(s.tool) === "search").length;
  const pages = steps.filter((s) => toolKind(s.tool) === "page").length;
  const usedWeb =
    searches + pages > 0 ||
    data.progress.some((line) => /search|fetch|read|web/i.test(line));

  const details = [
    searches > 0 ? plural(searches, "search", "searches") : null,
    pages > 0 ? `${plural(pages, "page", "pages")} read` : null,
    formatDuration(data.totalMs),
  ].filter(Boolean);

  const title = usedWeb ? "Researched the web" : "Worked on it";
  return details.length > 0 ? `${title} · ${details.join(", ")}` : title;
}

/**
 * TheStudent AI's server-side work for a reply (its own web search and page
 * reading), shown as a chain of thought: live status lines while the Space
 * works, then a summary. Text comes from the model server and is rendered
 * as plain text only.
 */
export function DzdActivity({
  data,
  isLoading,
  answerStarted,
}: {
  data: DzdActivityData;
  isLoading: boolean;
  answerStarted: boolean;
}) {
  const running = data.status === "running" && isLoading;
  const isResearching = running && !answerStarted;
  const { open, onOpenChange } = useResearchDisclosure(isResearching);

  const latest = data.progress.at(-1);
  const toolSteps = data.toolSteps ?? [];
  const showToolSteps = data.progress.length === 0 && toolSteps.length > 0;

  return (
    <ChainOfThought
      className="w-[min(100%,560px)]"
      data-testid="dzd-activity"
      onOpenChange={onOpenChange}
      open={open}
    >
      <ChainOfThoughtHeader className="text-[13px]" icon={GlobeIcon}>
        {isResearching ? (
          <Shimmer as="span" className="font-medium" duration={1}>
            {latest ?? "Working on it…"}
          </Shimmer>
        ) : (
          summarize(data)
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {showToolSteps
          ? toolSteps.map((step, index) => (
              <ChainOfThoughtStep
                className="text-[13px]"
                description={formatDuration(step.ms)}
                icon={kindIcon[toolKind(step.tool)]}
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are append-only
                key={`${step.tool}-${index}`}
                label={toolLabel(step.tool)}
                status="complete"
              />
            ))
          : data.progress.map((line, index) => {
              const active =
                isResearching && index === data.progress.length - 1;
              return (
                <ChainOfThoughtStep
                  className="text-[13px]"
                  icon={progressIcon(line)}
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines are append-only
                  key={`${index}-${line}`}
                  label={
                    active ? (
                      <Shimmer as="span" className="font-medium" duration={1}>
                        {line}
                      </Shimmer>
                    ) : (
                      line
                    )
                  }
                  status={active ? "active" : "complete"}
                />
              );
            })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
