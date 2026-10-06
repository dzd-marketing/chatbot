import type { UIMessage } from "ai";

/**
 * Uploaded PDF / Word / text files are stored in the message as a
 * `text/plain` file part holding the extracted text as a data URL (see
 * app/(chat)/api/files/upload/route.ts). Models can't take text files as
 * attachments, so before a request these parts become ordinary text parts.
 */

export const DOCUMENT_MEDIA_TYPE = "text/plain";

export function decodeTextDataUrl(url: string): string | null {
  const match = url.match(/^data:text\/plain(?:;[^,]*)?,(.*)$/s);
  if (!match) {
    return null;
  }
  const header = url.slice(0, url.indexOf(","));
  try {
    return header.includes(";base64")
      ? Buffer.from(match[1], "base64").toString("utf8")
      : decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Replaces document attachments with their text. Newer messages get the
 * character budget first; text beyond it is cut with a note.
 */
export function inlineDocumentAttachments<T extends UIMessage>(
  messages: T[],
  {
    perDocumentChars,
    totalChars,
  }: { perDocumentChars: number; totalChars: number }
): T[] {
  let remaining = totalChars;
  const converted = [...messages].reverse().map((message) => {
    if (
      !message.parts.some(
        (part) => part.type === "file" && part.mediaType === DOCUMENT_MEDIA_TYPE
      )
    ) {
      return message;
    }
    const parts = message.parts.map((part) => {
      if (part.type !== "file" || part.mediaType !== DOCUMENT_MEDIA_TYPE) {
        return part;
      }
      // The chat input stores the original file name as `name`.
      const name =
        part.filename ?? (part as { name?: string }).name ?? "document";
      const text = decodeTextDataUrl(part.url);
      if (text === null) {
        return {
          text: `[The attached file "${name}" could not be loaded.]`,
          type: "text" as const,
        };
      }
      const limit = Math.max(0, Math.min(perDocumentChars, remaining));
      const shown = text.slice(0, limit);
      remaining -= shown.length;
      const cut =
        shown.length < text.length
          ? `\n[… the rest of this document (${(text.length - shown.length).toLocaleString("en-US")} more characters) was left out because it is too long. Tell the student if their question may be about a later part.]`
          : "";
      return {
        text: `<attached_document name="${name.replace(/"/g, "'")}">\n${shown}${cut}\n</attached_document>`,
        type: "text" as const,
      };
    });
    return { ...message, parts };
  });
  return converted.reverse();
}
