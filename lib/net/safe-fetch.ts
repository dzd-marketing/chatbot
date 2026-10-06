import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * fetch() for URLs chosen by the AI or a student. Only public http(s)
 * addresses are allowed (no localhost, private networks or cloud metadata
 * endpoints), redirects are followed by hand so every hop is checked, and
 * the body size and total time are capped.
 */

export class SafeFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SafeFetchError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; DZDLearnBot/1.0; +https://github.com/dzd-marketing/chatbot)";

function isPrivateIPv4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address: string) {
  if (isIP(address) === 4) {
    return isPrivateIPv4(address);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    return isPrivateIPv4(lower.slice(7));
  }
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("ff")
  );
}

async function assertPublicUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new SafeFetchError("That isn't a valid link.", { cause: error });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SafeFetchError("Only http(s) links can be opened.");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("Links with passwords can't be opened.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new SafeFetchError("Only public websites can be opened.");
  }
  let addresses: { address: string }[];
  if (isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (error) {
      throw new SafeFetchError("That website couldn't be found.", {
        cause: error,
      });
    }
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => isPrivateAddress(address))
  ) {
    throw new SafeFetchError("Only public websites can be opened.");
  }
  return url;
}

async function readBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SafeFetchError(
      `This file is too large (over ${Math.round(maxBytes / 1024 / 1024)} MB).`
    );
  }
  if (!response.body) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    // Chunks must be read in order.
    // biome-ignore lint/performance/noAwaitInLoops: sequential stream reads
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchError(
        `This file is too large (over ${Math.round(maxBytes / 1024 / 1024)} MB).`
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export type SafeResponse = {
  status: number;
  ok: boolean;
  headers: Headers;
  /** The URL after redirects. */
  url: string;
  body?: Uint8Array;
};

export function safeFetch(
  rawUrl: string,
  {
    method = "GET",
    headers,
    maxBytes = 15 * 1024 * 1024,
    timeoutMs = 20_000,
    maxRedirects = 5,
    readBody: shouldReadBody = method !== "HEAD",
    signal,
  }: {
    method?: "GET" | "HEAD";
    headers?: Record<string, string>;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    readBody?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<SafeResponse> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const follow = async (
    current: string,
    redirectsLeft: number
  ): Promise<SafeResponse> => {
    const url = await assertPublicUrl(current);
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers: { "User-Agent": USER_AGENT, ...headers },
        method,
        redirect: "manual",
        signal: combined,
      });
    } catch (error) {
      throw new SafeFetchError(
        timeout.aborted
          ? "The website took too long to respond."
          : "The website couldn't be reached.",
        { cause: error }
      );
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => undefined);
      if (redirectsLeft <= 0) {
        throw new SafeFetchError("The link redirects too many times.");
      }
      return follow(new URL(location, url).toString(), redirectsLeft - 1);
    }
    const body = shouldReadBody
      ? await readBody(response, maxBytes)
      : await response.body?.cancel().catch(() => undefined);
    return {
      body: body instanceof Uint8Array ? body : undefined,
      headers: response.headers,
      ok: response.ok,
      status: response.status,
      url: url.toString(),
    };
  };

  return follow(rawUrl, maxRedirects);
}

/**
 * Google Drive / Docs share links -> direct download links, so the file
 * itself can be read or downloaded instead of Drive's viewer page.
 */
export function directDownloadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.hostname === "drive.google.com") {
    const id =
      url.pathname.match(/\/file\/d\/([\w-]+)/)?.[1] ??
      url.searchParams.get("id");
    if (id) {
      return `https://drive.google.com/uc?export=download&id=${id}`;
    }
  }
  if (url.hostname === "docs.google.com") {
    const match = url.pathname.match(
      /\/(document|presentation|spreadsheets)\/d\/([\w-]+)/
    );
    if (match) {
      const [, type, id] = match;
      const format =
        type === "document" ? "docx" : type === "presentation" ? "pdf" : "pdf";
      return `https://docs.google.com/${type}/d/${id}/export?format=${format}`;
    }
  }
  return raw;
}
