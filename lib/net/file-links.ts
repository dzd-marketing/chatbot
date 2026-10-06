/**
 * Finds the actual file (PDF, Word…) on a download page, e.g. the
 * "Download" button of a pastpapers.wiki paper page, so students get the
 * file itself instead of the website.
 */

const FILE_EXTENSION = /\.(pdf|docx?|pptx?|xlsx?|zip|rar)$/i;
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|ico)$/i;

const decodeEntities = (text: string) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCharCode(Number(code))
    );

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9\u0d80-\u0dff\u0b80-\u0bff]+/)
      .filter((word) => word.length > 1)
  );

type Candidate = { score: number; url: string; position: number };

/** Is this link a downloadable file (not a page)? */
export function looksLikeFileUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const path = decodeURIComponent(url.pathname);
  return (
    FILE_EXTENSION.test(path) ||
    /drive\.google\.com\/(file\/d\/|uc\b|open\b)/.test(raw) ||
    url.hostname === "drive.usercontent.google.com" ||
    /docs\.google\.com\/(document|presentation|spreadsheets)\/d\//.test(raw) ||
    // WordPress download plugins (WP File Download, Download Manager).
    url.searchParams.get("task") === "file.download" ||
    url.searchParams.has("wpdmdl")
  );
}

/**
 * The best file link on an HTML page, or null. `title` (what the student
 * asked for) breaks ties between several files.
 */
export function findFileLink(
  html: string,
  pageUrl: string,
  title = ""
): string | null {
  const wanted = words(title);
  const candidates: Candidate[] = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null = anchor.exec(html);
  while (match) {
    const [, attributes, inner] = match;
    const href = attributes.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const rawHref = href ? decodeEntities(href[1] ?? href[2] ?? "") : "";
    const text = decodeEntities(
      `${inner.replace(/<[^>]+>/g, " ")} ${attributes.match(/\btitle\s*=\s*"([^"]*)"/i)?.[1] ?? ""}`
    )
      .replace(/\s+/g, " ")
      .trim();
    let url: URL | null = null;
    try {
      url = rawHref ? new URL(rawHref, pageUrl) : null;
    } catch {
      url = null;
    }
    if (
      url &&
      (url.protocol === "https:" || url.protocol === "http:") &&
      !IMAGE_EXTENSION.test(url.pathname) &&
      url.searchParams.get("preview") !== "1" &&
      !/\bpreview\b/i.test(text) &&
      looksLikeFileUrl(url.toString())
    ) {
      let score = 0;
      if (/download|බාගත|பதிவிறக்க/i.test(text)) {
        score += 3;
      }
      if (/\.pdf$/i.test(url.pathname)) {
        score += 2;
      }
      if (url.hostname.includes("google.com")) {
        score += 1;
      }
      const linkWords = words(`${text} ${decodeURIComponent(url.pathname)}`);
      for (const word of wanted) {
        if (linkWords.has(word)) {
          score += 1;
        }
      }
      if (
        /marking|answer|scheme/i.test(text) &&
        !/marking|answer|scheme/i.test(title)
      ) {
        score -= 2;
      }
      candidates.push({ position: match.index, score, url: url.toString() });
    }
    match = anchor.exec(html);
  }
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.score - a.score || a.position - b.position);
  return candidates[0].url;
}
