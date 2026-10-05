"use client";

import { FileTextIcon, GlobeIcon, TriangleAlertIcon } from "lucide-react";
import type { ChatMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Shimmer } from "../ai-elements/shimmer";

type MessagePart = ChatMessage["parts"][number];
type WebSearchPart = Extract<MessagePart, { type: "tool-webSearch" }>;
type WebFetchPart = Extract<MessagePart, { type: "tool-webFetch" }>;

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

function Chip({
  failed = false,
  icon,
  children,
}: {
  failed?: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex w-fit max-w-full items-center gap-2 rounded-full border border-border/40 px-2.5 py-1 text-[12px] text-muted-foreground leading-5",
        failed ? "bg-muted/25" : "bg-muted/40"
      )}
      data-state={failed ? "error" : "ok"}
    >
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="flex min-w-0 items-center gap-1.5">{children}</span>
    </div>
  );
}

export function WebSearchCall({ part }: { part: WebSearchPart }) {
  const query = part.input?.query ?? "";
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const failed =
    part.state === "output-error" ||
    (part.state === "output-available" && "error" in part.output);

  if (isRunning) {
    return (
      <Chip icon={<GlobeIcon className="size-3.5" />}>
        <Shimmer as="span" className="shrink-0 font-medium" duration={1}>
          Searching the web
        </Shimmer>
        {query ? (
          <span className="truncate text-foreground/70">“{query}”</span>
        ) : null}
      </Chip>
    );
  }

  if (failed) {
    return (
      <Chip failed icon={<TriangleAlertIcon className="size-3.5" />}>
        <span className="shrink-0">Web search unavailable</span>
        {query ? <span className="truncate opacity-70">“{query}”</span> : null}
      </Chip>
    );
  }

  return (
    <Chip icon={<GlobeIcon className="size-3.5 text-brand" />}>
      <span className="shrink-0">Searched the web</span>
      {query ? (
        <span className="truncate text-foreground/80">“{query}”</span>
      ) : null}
    </Chip>
  );
}

export function WebFetchCall({ part }: { part: WebFetchPart }) {
  const url = part.input?.url;
  const host = hostnameOf(url);
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const failed =
    part.state === "output-error" ||
    (part.state === "output-available" && "error" in part.output);

  if (isRunning) {
    return (
      <Chip icon={<FileTextIcon className="size-3.5" />}>
        <Shimmer as="span" className="shrink-0 font-medium" duration={1}>
          Reading page
        </Shimmer>
        {host ? (
          <span className="truncate text-foreground/70">{host}</span>
        ) : null}
      </Chip>
    );
  }

  if (failed) {
    return (
      <Chip failed icon={<TriangleAlertIcon className="size-3.5" />}>
        <span className="shrink-0">Couldn’t open</span>
        {host ? <span className="truncate opacity-70">{host}</span> : null}
      </Chip>
    );
  }

  return (
    <Chip icon={<FileTextIcon className="size-3.5 text-brand" />}>
      <span className="shrink-0">Read</span>
      {isSafeHttpUrl(url) ? (
        <a
          className="truncate text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/40"
          href={url}
          rel="noopener noreferrer"
          target="_blank"
        >
          {host}
        </a>
      ) : (
        <span className="truncate text-foreground/80">{host}</span>
      )}
    </Chip>
  );
}
