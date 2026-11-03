/** Browser download helpers for exported documents. */

import { fileNameFor } from "./file-name";

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
