/** Browser download helpers for exported documents. */

/** A safe file name from a document title. */
export function fileNameFor(title: string, extension: string) {
  const base =
    Array.from(title)
      .map((character) => (character.charCodeAt(0) < 32 ? " " : character))
      .join("")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "DZD Learn document";
  return `${base}.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function downloadWord(title: string, markdown: string) {
  const { markdownToDocx } = await import("./markdown-docx");
  const blob = await markdownToDocx(title, markdown);
  downloadBlob(blob, fileNameFor(title, "docx"));
}

export async function printAsPdf(title: string, markdown: string) {
  const { printMarkdown } = await import("./print-pdf");
  await printMarkdown(title, markdown);
}
