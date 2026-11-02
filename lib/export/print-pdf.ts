import katex from "@/lib/katex";
import {
  createMarkdown,
  escapeHtml,
  prepareMarkdown,
} from "@/lib/markdown/marked";

/**
 * "Save as PDF": the document is laid out as a clean printable page and the
 * browser's print dialog opens (choose "Save as PDF"). The browser shapes
 * Sinhala and Tamil text properly, which PDF libraries usually don't.
 * Maths is KaTeX MathML, which browsers draw natively (no fonts needed).
 * Raw HTML in the Markdown is shown as text, never run.
 */

const markdown = createMarkdown((tex, displayMode) => {
  const math = katex.renderToString(tex, {
    displayMode,
    output: "mathml",
    throwOnError: false,
  });
  return displayMode ? `<div class="math-display">${math}</div>` : math;
});

const STYLES = `
@page { margin: 18mm 16mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0 auto; max-width: 760px; padding: 24px;
  color: #111; background: #fff;
  font: 11.5pt/1.6 system-ui, -apple-system, "Segoe UI", Roboto,
    "Noto Sans Sinhala", "Iskoola Pota", "Noto Sans Tamil", "Nirmala UI",
    Arial, sans-serif;
}
h1, h2, h3, h4 { color: #065f46; line-height: 1.25; margin: 1.2em 0 0.5em; break-after: avoid; }
h1 { font-size: 22pt; margin-top: 0; }
h2 { font-size: 16pt; }
h3 { font-size: 13pt; }
p, li { orphans: 3; widows: 3; }
a { color: #047857; }
code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 0.92em;
  background: #f1f4f2; padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: #f3f5f4; padding: 12px 14px; border-radius: 8px; overflow: hidden;
  white-space: pre-wrap; word-break: break-word; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: 0.2em 1em; border-left: 3px solid #10b981; color: #333; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; break-inside: auto; }
th, td { border: 1px solid #cfd8d3; padding: 6px 9px; text-align: left; vertical-align: top; }
th { background: #e7f6ef; }
tr { break-inside: avoid; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 0; }
img { max-width: 100%; }
math { font-size: 1.08em; }
.math-display { margin: 0.9em 0; text-align: center; overflow-x: auto; break-inside: avoid; }
.math-display math { display: block math; }
.dzd-footer { margin-top: 2.5em; color: #888; font-size: 8.5pt; text-align: right; }
`;

export function markdownToPrintableHtml(title: string, source: string) {
  const body = markdown.parse(prepareMarkdown(source)) as string;
  const startsWithTitle = /^\s*#\s/.test(source);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLES}</style></head><body>${startsWithTitle ? "" : `<h1>${escapeHtml(title)}</h1>`}${body}<div class="dzd-footer">TheStudent</div></body></html>`;
}

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1);

export function printMarkdown(title: string, source: string) {
  const html = markdownToPrintableHtml(title, source);

  // iOS Safari prints the whole app instead of an iframe, so use a window.
  if (isIOS()) {
    const popup = window.open("", "_blank");
    if (!popup) {
      throw new Error("Please allow pop-ups to save as PDF.");
    }
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
    setTimeout(() => popup.print(), 300);
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const frame = document.createElement("iframe");
    // No scripts run inside; the parent page triggers printing.
    frame.setAttribute("sandbox", "allow-modals allow-same-origin");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText =
      "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
    frame.srcdoc = html;

    // Browsers name the PDF after the page title.
    const previousTitle = document.title;
    const cleanUp = () => {
      document.title = previousTitle;
      setTimeout(() => frame.remove(), 1000);
    };

    frame.onload = async () => {
      try {
        const win = frame.contentWindow;
        if (!win) {
          throw new Error("Printing isn't available in this browser.");
        }
        await win.document.fonts?.ready;
        document.title = title;
        win.addEventListener("afterprint", cleanUp, { once: true });
        win.focus();
        win.print();
        // Some browsers don't fire afterprint.
        setTimeout(cleanUp, 60_000);
        resolve();
      } catch (error) {
        cleanUp();
        reject(error);
      }
    };
    document.body.appendChild(frame);
  });
}
