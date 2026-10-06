"use client";

import {
  DownloadIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  GlobeIcon,
  Link2OffIcon,
  type LucideIcon,
  PresentationIcon,
} from "lucide-react";
import type { CheckedFile, FileKind } from "@/lib/ai/tools/share-files";
import { cn } from "@/lib/utils";

const KIND_STYLE: Record<
  FileKind,
  { icon: LucideIcon; label: string; tint: string }
> = {
  archive: {
    icon: FileArchiveIcon,
    label: "ZIP",
    tint: "bg-amber-500/12 text-amber-700 dark:text-amber-400",
  },
  file: {
    icon: FileIcon,
    label: "File",
    tint: "bg-primary/12 text-primary",
  },
  image: {
    icon: FileImageIcon,
    label: "Image",
    tint: "bg-violet-500/12 text-violet-700 dark:text-violet-400",
  },
  page: {
    icon: GlobeIcon,
    label: "Web page",
    tint: "bg-muted-foreground/12 text-muted-foreground",
  },
  pdf: {
    icon: FileTextIcon,
    label: "PDF",
    tint: "bg-red-500/12 text-red-600 dark:text-red-400",
  },
  sheet: {
    icon: FileSpreadsheetIcon,
    label: "Sheet",
    tint: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
  },
  slides: {
    icon: PresentationIcon,
    label: "Slides",
    tint: "bg-orange-500/12 text-orange-700 dark:text-orange-400",
  },
  word: {
    icon: FileIcon,
    label: "Word",
    tint: "bg-sky-500/12 text-sky-700 dark:text-sky-400",
  },
};

function formatSize(bytes: number | undefined) {
  if (!bytes) {
    return null;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const isHttp = (url: string | undefined): url is string =>
  !!url && /^https?:\/\//i.test(url);

export function FileCardsSkeleton({ titles }: { titles: string[] }) {
  const rows = titles.length > 0 ? titles : ["", ""];
  return (
    <div className="grid w-full max-w-[640px] gap-2 sm:grid-cols-2">
      {rows.map((title, index) => (
        <div
          className="flex items-center gap-3 rounded-xl border border-border/50 bg-card p-3"
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
          key={index}
        >
          <div className="size-10 shrink-0 animate-pulse rounded-lg bg-muted-foreground/10" />
          <div className="min-w-0 flex-1">
            {title ? (
              <div className="truncate font-medium text-sm">{title}</div>
            ) : (
              <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted-foreground/12" />
            )}
            <div className="mt-1 text-muted-foreground text-xs">
              Checking link…
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function FileCard({ file }: { file: CheckedFile }) {
  const style = KIND_STYLE[file.kind] ?? KIND_STYLE.page;
  const Icon = style.icon;
  const broken = file.status === "broken";
  // Downloads through /api/files/download (right in the chat) when
  // possible; otherwise the file's own link.
  const primaryUrl = file.downloadPath
    ? `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${file.downloadPath}`
    : (file.downloadUrl ?? file.url);
  const size = formatSize(file.sizeBytes);
  const isPage = file.kind === "page";

  return (
    <div
      className={cn(
        "flex flex-col gap-2.5 rounded-xl border border-border/50 bg-card p-3 shadow-[var(--shadow-card)]",
        broken && "opacity-60"
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            broken ? "bg-muted text-muted-foreground" : style.tint
          )}
        >
          {broken ? (
            <Link2OffIcon className="size-[18px]" />
          ) : (
            <Icon className="size-[18px]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-medium text-sm leading-snug">
            {file.title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
            <span className="truncate">{file.host}</span>
            <span aria-hidden="true">·</span>
            <span>{style.label}</span>
            {size ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{size}</span>
              </>
            ) : null}
          </div>
          {file.description ? (
            <div className="mt-1 line-clamp-2 text-muted-foreground text-xs">
              {file.description}
            </div>
          ) : null}
        </div>
      </div>

      {broken ? (
        <div className="font-medium text-red-600 text-xs dark:text-red-400">
          Link not working
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {file.downloadPath || isHttp(primaryUrl) ? (
            <a
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
              href={primaryUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              {isPage ? (
                <ExternalLinkIcon className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              {isPage ? "Open" : "Download"}
            </a>
          ) : null}
          {file.downloadUrl && isHttp(file.url) ? (
            <a
              aria-label="View the source page"
              className="inline-flex h-8 items-center justify-center rounded-lg border border-border/60 px-2.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              href={file.url}
              rel="noopener noreferrer"
              target="_blank"
              title={`View on ${file.host}`}
            >
              <ExternalLinkIcon className="size-3.5" />
            </a>
          ) : null}
          {file.status === "unverified" ? (
            <span
              className="text-[11px] text-muted-foreground"
              title="The website didn't allow the link to be checked."
            >
              Not checked
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function FileCards({ files }: { files: CheckedFile[] }) {
  if (files.length === 0) {
    return null;
  }
  // Working links first.
  const sorted = [...files].sort(
    (a, b) => Number(a.status === "broken") - Number(b.status === "broken")
  );
  return (
    <div className="grid w-full max-w-[640px] gap-2 sm:grid-cols-2">
      {sorted.map((file) => (
        <FileCard file={file} key={file.url} />
      ))}
    </div>
  );
}
