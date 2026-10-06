import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  directDownloadUrl,
  SafeFetchError,
  safeFetch,
} from "@/lib/net/safe-fetch";

/**
 * Shows documents (past papers, marking schemes, syllabi...) as download
 * cards. Every link is checked first, so students aren't sent to dead
 * links. Files stay on the original website.
 */

const CHECK_TIMEOUT_MS = 8000;

export type FileKind =
  | "pdf"
  | "word"
  | "slides"
  | "sheet"
  | "image"
  | "archive"
  | "page";

/** ok: works; broken: not found; unverified: the site wouldn't say. */
export type LinkStatus = "ok" | "broken" | "unverified";

export type CheckedFile = {
  title: string;
  description?: string;
  url: string;
  host: string;
  kind: FileKind;
  status: LinkStatus;
  sizeBytes?: number;
  /** A direct download link, when different (Google Drive). */
  downloadUrl?: string;
};

function kindOf(url: string, contentType: string): FileKind {
  const type = contentType.toLowerCase();
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (type.includes("pdf") || path.endsWith(".pdf")) {
    return "pdf";
  }
  if (
    type.includes("wordprocessingml") ||
    type.includes("msword") ||
    /\.docx?$/.test(path) ||
    url.includes("docs.google.com/document")
  ) {
    return "word";
  }
  if (
    type.includes("presentation") ||
    /\.pptx?$/.test(path) ||
    url.includes("docs.google.com/presentation")
  ) {
    return "slides";
  }
  if (
    type.includes("spreadsheet") ||
    /\.(xlsx?|csv)$/.test(path) ||
    url.includes("docs.google.com/spreadsheets")
  ) {
    return "sheet";
  }
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(path)) {
    return "image";
  }
  if (type.includes("zip") || /\.(zip|rar|7z)$/.test(path)) {
    return "archive";
  }
  if (url.includes("drive.google.com/file/")) {
    // Drive's viewer is HTML, but the link is a file.
    return "pdf";
  }
  return "page";
}

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function checkLink(url: string, signal?: AbortSignal) {
  const options = { signal, timeoutMs: CHECK_TIMEOUT_MS };
  try {
    let response = await safeFetch(url, { ...options, method: "HEAD" });
    // Some servers don't support HEAD; ask for the first byte instead.
    if ([403, 405, 501].includes(response.status) || !response.ok) {
      response = await safeFetch(url, {
        ...options,
        headers: { Range: "bytes=0-0" },
        readBody: false,
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    const range = response.headers.get("content-range");
    const size = range
      ? Number(range.split("/")[1])
      : Number(response.headers.get("content-length"));
    let status: LinkStatus = "unverified";
    if (response.ok) {
      status = "ok";
    } else if ([404, 410].includes(response.status)) {
      status = "broken";
    }
    return {
      contentType,
      sizeBytes:
        Number.isFinite(size) && size > 0 && response.ok ? size : undefined,
      status,
    };
  } catch (error) {
    const message = error instanceof SafeFetchError ? error.message : "";
    const notFound = /couldn't be found|isn't a valid|Only/.test(message);
    return {
      contentType: "",
      sizeBytes: undefined,
      status: (notFound ? "broken" : "unverified") as LinkStatus,
    };
  }
}

export const shareFiles = tool({
  description:
    "Show documents to the student as download cards (past papers, marking schemes, syllabi, notes, timetables). Each link is checked first and the result says which ones work. Only use links that appeared in your tool results or that the student gave you; never make up links. After calling it, refer to the cards briefly instead of listing the same links again.",
  execute: async ({ files }, { abortSignal }) => {
    const unique = files.filter(
      (file, index) => files.findIndex((f) => f.url === file.url) === index
    );
    const checked = await Promise.all(
      unique.map(async (file): Promise<CheckedFile> => {
        const download = directDownloadUrl(file.url);
        const result = await checkLink(file.url, abortSignal);
        return {
          description: file.description,
          downloadUrl: download === file.url ? undefined : download,
          host: hostOf(file.url),
          kind: kindOf(file.url, result.contentType),
          sizeBytes: result.sizeBytes,
          status: result.status,
          title: file.title,
          url: file.url,
        };
      })
    );
    return {
      broken: checked.filter((file) => file.status === "broken").length,
      files: checked,
      working: checked.filter((file) => file.status === "ok").length,
    };
  },
  inputSchema: z.object({
    files: z
      .array(
        z.object({
          description: z
            .string()
            .max(160)
            .optional()
            .describe("Short note, e.g. 'English medium · Part I and II'."),
          title: z
            .string()
            .min(1)
            .max(120)
            .describe("Clear name, e.g. '2020 A/L Science for Technology'."),
          url: z.url({ protocol: /^https?$/ }).max(2000),
        })
      )
      .min(1)
      .max(10),
  }),
});
