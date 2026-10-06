import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { findFileLink, looksLikeFileUrl } from "@/lib/net/file-links";
import {
  directDownloadUrl,
  SafeFetchError,
  safeFetch,
} from "@/lib/net/safe-fetch";
import { signedDownloadPath } from "@/lib/net/signed-download";

/**
 * Shows documents (past papers, marking schemes, syllabi...) as download
 * cards. Every link is checked first, so students aren't sent to dead
 * links. When the AI gives a download page (e.g. a pastpapers.wiki paper
 * page), the file link on that page is found, so the student downloads the
 * file itself from the chat (through /api/files/download).
 */

const CHECK_TIMEOUT_MS = 8000;
/** Download pages are read to find the file link on them. */
const MAX_PAGE_BYTES = 3 * 1024 * 1024;

export type FileKind =
  | "pdf"
  | "word"
  | "slides"
  | "sheet"
  | "image"
  | "archive"
  | "file"
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
  /** The file itself, when `url` is a page or a Drive viewer link. */
  downloadUrl?: string;
  /** Signed /api/files/download link: downloads the file in the chat. */
  downloadPath?: string;
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
  if (looksLikeFileUrl(url) && !type.includes("html")) {
    return "file";
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

/** The HTML of a download page, or null. */
async function readPage(url: string, signal?: AbortSignal) {
  try {
    const response = await safeFetch(url, {
      maxBytes: MAX_PAGE_BYTES,
      signal,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const type = response.headers.get("content-type") ?? "";
    if (!(response.ok && response.body && /html/i.test(type))) {
      return null;
    }
    return {
      html: new TextDecoder("utf-8").decode(response.body),
      url: response.url,
    };
  } catch {
    return null;
  }
}

type FileInput = { description?: string; title: string; url: string };

async function inspectFile(
  file: FileInput,
  signal?: AbortSignal
): Promise<CheckedFile> {
  const base = {
    description: file.description,
    host: hostOf(file.url),
    title: file.title,
    url: file.url,
  };
  const withFile = (
    fileUrl: string,
    result: Awaited<ReturnType<typeof checkLink>>
  ): CheckedFile => ({
    ...base,
    downloadPath:
      result.status === "broken"
        ? undefined
        : signedDownloadPath(fileUrl, file.title),
    downloadUrl: fileUrl === file.url ? undefined : fileUrl,
    kind: kindOf(fileUrl, result.contentType),
    sizeBytes: result.sizeBytes,
    status: result.status,
  });

  // A file link (or a Drive / Docs link that can be made one).
  const direct = directDownloadUrl(file.url);
  if (direct !== file.url || looksLikeFileUrl(file.url)) {
    return withFile(direct, await checkLink(direct, signal));
  }

  const page = await checkLink(file.url, signal);
  if (page.status === "broken") {
    return { ...base, kind: kindOf(file.url, ""), status: "broken" };
  }
  if (page.contentType && !/html/i.test(page.contentType)) {
    // The link is already a file (e.g. a PDF without ".pdf").
    return withFile(file.url, page);
  }

  // A web page: look for the file's download link on it.
  const html = await readPage(file.url, signal);
  const found = html ? findFileLink(html.html, html.url, file.title) : null;
  if (found) {
    const fileUrl = directDownloadUrl(found);
    const result = await checkLink(fileUrl, signal);
    if (result.status !== "broken") {
      return withFile(fileUrl, result);
    }
  }
  return {
    ...base,
    kind: "page",
    sizeBytes: undefined,
    status: page.status,
  };
}

export const shareFiles = tool({
  description:
    "Show documents to the student as download cards (past papers, marking schemes, syllabi, notes, timetables) that download the file right in the chat. Give the direct file link when you have one, or the page that offers the download: the file link on that page is found automatically. Each link is checked first and the result says which ones work. Only use links that appeared in your tool results or that the student gave you; never make up links. After calling it, refer to the cards briefly instead of listing the same links again.",
  execute: async ({ files }, { abortSignal }) => {
    const unique = files.filter(
      (file, index) => files.findIndex((f) => f.url === file.url) === index
    );
    const checked = await Promise.all(
      unique.map((file) => inspectFile(file, abortSignal))
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
