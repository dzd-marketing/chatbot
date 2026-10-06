import { NextResponse } from "next/server";
import { fileNameFor } from "@/lib/export/file-name";
import { SafeFetchError, safeFetch } from "@/lib/net/safe-fetch";
import { verifyDownload } from "@/lib/net/signed-download";

/**
 * Downloads a file from a download card right in the chat, with a clean
 * file name. Only signed links made by the shareFiles tool are served.
 *
 * Vercel limits function responses to 4.5 MB, so bigger files (and sites
 * that block servers) are sent to the browser as a redirect to the file's
 * own download link instead.
 */

export const maxDuration = 60;

const MAX_PROXY_BYTES = 4 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "application/msword": "doc",
  "application/pdf": "pdf",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/x-rar-compressed": "rar",
  "application/zip": "zip",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function extensionFor(url: string, headers: Headers) {
  const disposition = headers.get("content-disposition") ?? "";
  const fromHeader = disposition.match(
    /filename\*?=(?:UTF-8'')?"?[^";]*\.(\w{2,5})"?/i
  );
  if (fromHeader) {
    return fromHeader[1].toLowerCase();
  }
  try {
    const fromPath = new URL(url).pathname.match(/\.(\w{2,5})$/);
    if (fromPath) {
      return fromPath[1].toLowerCase();
    }
  } catch {
    // Fall through to the content type.
  }
  const type = (headers.get("content-type") ?? "").split(";")[0].trim();
  return EXTENSIONS[type] ?? "pdf";
}

export async function GET(request: Request) {
  const verified = verifyDownload(new URL(request.url).searchParams);
  if (!verified) {
    return NextResponse.json(
      { error: "This download link isn't valid." },
      { status: 400 }
    );
  }
  const { name, url } = verified;
  const sendToSource = () => NextResponse.redirect(url, 302);

  let response: Awaited<ReturnType<typeof safeFetch>>;
  try {
    response = await safeFetch(url, {
      maxBytes: MAX_PROXY_BYTES,
      signal: request.signal,
      timeoutMs: 25_000,
    });
  } catch (error) {
    // Too large, slow or blocked: let the browser get it directly.
    if (!(error instanceof SafeFetchError)) {
      console.error("Download failed:", error);
    }
    return sendToSource();
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (
    !(response.ok && response.body?.byteLength) ||
    /html/i.test(contentType)
  ) {
    // A login page, a "confirm download" page, or an error.
    return sendToSource();
  }

  const fileName = fileNameFor(
    name,
    extensionFor(response.url, response.headers)
  );
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new Response(new Uint8Array(response.body), {
    headers: {
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": String(response.body.byteLength),
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Content-Type": contentType || "application/octet-stream",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
