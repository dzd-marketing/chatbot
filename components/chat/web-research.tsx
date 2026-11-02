"use client";

import type { ReasoningUIPart } from "ai";
import {
  BrainIcon,
  FileTextIcon,
  GlobeIcon,
  SearchIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "../ai-elements/chain-of-thought";
import { Shimmer } from "../ai-elements/shimmer";

type MessagePart = ChatMessage["parts"][number];
type WebSearchPart = Extract<MessagePart, { type: "tool-webSearch" }>;
/** Reading a web page (webFetch) or a PDF / Word file (readDocument). */
type WebFetchPart = Extract<
  MessagePart,
  { type: "tool-webFetch" } | { type: "tool-readDocument" }
>;
export type ResearchPart = ReasoningUIPart | WebSearchPart | WebFetchPart;

const AUTO_CLOSE_DELAY = 1000;
const MAX_BADGES = 6;
const REASONING_PREVIEW_CHARS = 280;

export function isWebToolPart(
  part: MessagePart
): part is WebSearchPart | WebFetchPart {
  return (
    part.type === "tool-webSearch" ||
    part.type === "tool-webFetch" ||
    part.type === "tool-readDocument"
  );
}

/** Parts that belong in the chain of thought when a message used web tools. */
export function isResearchPart(part: MessagePart): part is ResearchPart {
  return (
    isWebToolPart(part) ||
    (part.type === "reasoning" && part.text.trim().length > 0)
  );
}

function hostnameOf(url: string | undefined) {
  if (!url) {
    return "";
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isSafeHttpUrl(url: string | undefined): url is string {
  if (!url) {
    return false;
  }
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function isToolRunning(part: WebSearchPart | WebFetchPart) {
  return part.state === "input-streaming" || part.state === "input-available";
}

function toolError(part: WebSearchPart | WebFetchPart) {
  if (part.state === "output-error") {
    return "The web service is unavailable right now.";
  }
  if (part.state === "output-available" && "error" in part.output) {
    return part.output.error;
  }
  return null;
}

function isPartActive(part: ResearchPart, isLoading: boolean) {
  if (!isLoading) {
    return false;
  }
  if (part.type === "reasoning") {
    return part.state === "streaming";
  }
  return isToolRunning(part);
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/* -------------------------------------------------------------------------- */

function SourceBadge({ url, title }: { url: string; title?: string }) {
  const host = hostnameOf(url);
  if (!isSafeHttpUrl(url)) {
    return <ChainOfThoughtSearchResult>{host}</ChainOfThoughtSearchResult>;
  }
  return (
    <ChainOfThoughtSearchResult asChild>
      <a
        className="max-w-[14rem]"
        href={url}
        rel="noopener noreferrer"
        target="_blank"
        title={title ? `${title}\n${url}` : url}
      >
        <GlobeIcon className="size-3 shrink-0 opacity-70" />
        <span className="truncate">{host}</span>
      </a>
    </ChainOfThoughtSearchResult>
  );
}

function ReasoningStep({
  part,
  active,
}: {
  part: ReasoningUIPart;
  active: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const text = part.text.trim();
  const isLong = text.length > REASONING_PREVIEW_CHARS;

  let body = (
    <p
      className={cn(
        "whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed",
        !expanded && isLong ? "line-clamp-3" : null
      )}
    >
      {text}
    </p>
  );
  if (active) {
    // While streaming, show the live tail so it reads like a ticker.
    const tail = isLong ? `…${text.slice(-REASONING_PREVIEW_CHARS)}` : text;
    body = (
      <p className="whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
        {tail}
      </p>
    );
  }

  return (
    <ChainOfThoughtStep
      className="text-[13px]"
      icon={BrainIcon}
      label={
        active ? (
          <Shimmer as="span" className="font-medium" duration={1}>
            Thinking…
          </Shimmer>
        ) : (
          "Thought it through"
        )
      }
      status={active ? "active" : "complete"}
    >
      {body}
      {!active && isLong ? (
        <button
          className="text-muted-foreground text-xs underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
          onClick={toggle}
          type="button"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </ChainOfThoughtStep>
  );
}

function SearchStep({
  part,
  isLoading,
}: {
  part: WebSearchPart;
  isLoading: boolean;
}) {
  const query = part.input?.query ?? "";
  const quoted = query ? ` “${query}”` : "";
  const running = isToolRunning(part);
  const error = toolError(part);

  if (running && isLoading) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        icon={SearchIcon}
        label={
          <Shimmer as="span" className="font-medium" duration={1}>
            {`Searching the web for${quoted}`}
          </Shimmer>
        }
        status="active"
      />
    );
  }

  if (running) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        icon={SearchIcon}
        label={`Search stopped${quoted ? ` for${quoted}` : ""}`}
        status="pending"
      />
    );
  }

  if (error) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        description={error}
        icon={TriangleAlertIcon}
        label={`Couldn’t search for${quoted}`}
        status="complete"
      />
    );
  }

  const sources =
    part.state === "output-available" && "sources" in part.output
      ? (part.output.sources ?? []).filter((source) =>
          isSafeHttpUrl(source.url)
        )
      : [];
  const extra = sources.length - MAX_BADGES;

  return (
    <ChainOfThoughtStep
      className="text-[13px]"
      description={sources.length === 0 ? "No results found" : undefined}
      icon={SearchIcon}
      label={`Searched the web for${quoted}`}
      status="complete"
    >
      {sources.length > 0 ? (
        <ChainOfThoughtSearchResults>
          {sources.slice(0, MAX_BADGES).map((source) => (
            <SourceBadge
              key={source.url}
              title={source.title}
              url={source.url}
            />
          ))}
          {extra > 0 ? (
            <ChainOfThoughtSearchResult>
              +{extra} more
            </ChainOfThoughtSearchResult>
          ) : null}
        </ChainOfThoughtSearchResults>
      ) : null}
    </ChainOfThoughtStep>
  );
}

function FetchStep({
  part,
  isLoading,
}: {
  part: WebFetchPart;
  isLoading: boolean;
}) {
  const url = part.input?.url;
  const host = hostnameOf(url);
  const running = isToolRunning(part);
  const error = toolError(part);
  const isDocument = part.type === "tool-readDocument";
  const thing = isDocument ? "document" : "page";

  if (running && isLoading) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        icon={FileTextIcon}
        label={
          <Shimmer as="span" className="font-medium" duration={1}>
            {host
              ? `Reading ${isDocument ? "a document from " : ""}${host}`
              : `Reading ${thing}`}
          </Shimmer>
        }
        status="active"
      />
    );
  }

  if (running) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        icon={FileTextIcon}
        label={`Stopped reading ${host || thing}`}
        status="pending"
      />
    );
  }

  if (error) {
    return (
      <ChainOfThoughtStep
        className="text-[13px]"
        description={error}
        icon={TriangleAlertIcon}
        label={`Couldn’t open ${isDocument ? "the document" : host || thing}`}
        status="complete"
      />
    );
  }

  const title =
    part.state === "output-available" && "title" in part.output
      ? part.output.title
      : undefined;

  return (
    <ChainOfThoughtStep
      className="text-[13px]"
      icon={FileTextIcon}
      label={
        title
          ? `Read ${isDocument ? "document " : ""}“${title}”`
          : `Read ${host || thing}`
      }
      status="complete"
    >
      {url ? (
        <ChainOfThoughtSearchResults>
          <SourceBadge title={title} url={url} />
        </ChainOfThoughtSearchResults>
      ) : null}
    </ChainOfThoughtStep>
  );
}

/* -------------------------------------------------------------------------- */

function summarize(parts: ResearchPart[]) {
  let searches = 0;
  let pages = 0;
  let documents = 0;
  let failures = 0;
  for (const part of parts) {
    if (part.type === "reasoning") {
      continue;
    }
    if (toolError(part)) {
      failures += 1;
    } else if (part.type === "tool-webSearch") {
      searches += 1;
    } else if (part.type === "tool-readDocument") {
      documents += 1;
    } else {
      pages += 1;
    }
  }

  if (searches === 0 && pages === 0 && documents === 0) {
    return failures > 0 ? "Web search unavailable" : "Researched the web";
  }
  const details = [
    searches > 0 ? plural(searches, "search", "searches") : null,
    pages > 0 ? `${plural(pages, "page", "pages")} read` : null,
    documents > 0 ? `${plural(documents, "document", "documents")} read` : null,
  ].filter(Boolean);
  return `Researched the web · ${details.join(", ")}`;
}

function activeLabel(parts: ResearchPart[], isLoading: boolean) {
  const current = [...parts].reverse().find((p) => isPartActive(p, isLoading));
  if (current?.type === "tool-webFetch") {
    return "Reading sources…";
  }
  if (current?.type === "tool-readDocument") {
    return "Reading the document…";
  }
  if (current?.type === "reasoning") {
    return "Thinking…";
  }
  return "Searching the web…";
}

/**
 * Open while the model is researching, then collapse shortly after the
 * answer starts, unless the student opened or closed it themselves.
 */
export function useResearchDisclosure(isResearching: boolean) {
  const [open, setOpen] = useState(isResearching);
  const userToggledRef = useRef(false);
  const wasResearchingRef = useRef(isResearching);

  useEffect(() => {
    if (isResearching) {
      wasResearchingRef.current = true;
      if (!userToggledRef.current) {
        setOpen(true);
      }
      return;
    }
    if (!wasResearchingRef.current || userToggledRef.current) {
      return;
    }
    wasResearchingRef.current = false;
    const timer = setTimeout(() => setOpen(false), AUTO_CLOSE_DELAY);
    return () => clearTimeout(timer);
  }, [isResearching]);

  const onOpenChange = useCallback((next: boolean) => {
    userToggledRef.current = true;
    setOpen(next);
  }, []);

  return { onOpenChange, open };
}

/**
 * Renders a message's reasoning + web search/read steps as a chain of
 * thought. Open while TheStudent AI is researching, then collapses once the answer
 * starts (unless the student opened or closed it themselves).
 */
export function WebResearch({
  parts,
  isLoading,
  answerStarted,
}: {
  parts: ResearchPart[];
  isLoading: boolean;
  answerStarted: boolean;
}) {
  const isResearching = isLoading && !answerStarted;
  const { open, onOpenChange } = useResearchDisclosure(isResearching);

  const hasReasoning = parts.some((part) => part.type === "reasoning");

  return (
    <ChainOfThought
      className="w-[min(100%,560px)]"
      data-testid="web-research"
      onOpenChange={onOpenChange}
      open={open}
    >
      <ChainOfThoughtHeader
        className="text-[13px]"
        icon={hasReasoning ? BrainIcon : GlobeIcon}
      >
        {isResearching ? (
          <Shimmer as="span" className="font-medium" duration={1}>
            {activeLabel(parts, isLoading)}
          </Shimmer>
        ) : (
          summarize(parts)
        )}
      </ChainOfThoughtHeader>
      <ChainOfThoughtContent>
        {parts.map((part, index) => {
          const key = `${part.type}-${"toolCallId" in part ? part.toolCallId : index}`;
          if (part.type === "reasoning") {
            return (
              <ReasoningStep
                active={isPartActive(part, isLoading)}
                key={key}
                part={part}
              />
            );
          }
          if (part.type === "tool-webSearch") {
            return <SearchStep isLoading={isLoading} key={key} part={part} />;
          }
          return <FetchStep isLoading={isLoading} key={key} part={part} />;
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
}
