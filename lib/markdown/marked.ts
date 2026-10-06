import { Marked, type Tokens } from "marked";
import markedKatex from "marked-katex-extension";
import "@/lib/katex";
import { normalizeMathDelimiters } from "@/lib/math-markdown";

/**
 * Markdown -> HTML / tokens for AI documents (the document view and the
 * Word / PDF downloads), with maths ($…$, $$…$$, \(…\), \[…\]) via
 * marked-katex-extension. Raw HTML in the Markdown is shown as text, never
 * run, and only http(s)/mailto links are kept.
 */

export type MathToken = Tokens.Generic & {
  type: "inlineKatex" | "blockKatex";
  text: string;
  displayMode: boolean;
};

export const escapeHtml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** `renderMath` turns TeX into HTML (KaTeX, MathML or a placeholder). */
export function createMarkdown(
  renderMath: (tex: string, displayMode: boolean) => string
) {
  return new Marked(
    {
      async: false,
      gfm: true,
      renderer: {
        html: ({ block, text }) =>
          block ? `<p>${escapeHtml(text.trim())}</p>\n` : escapeHtml(text),
      },
      walkTokens: (token) => {
        if (
          (token.type === "link" || token.type === "image") &&
          !/^(https?:|mailto:|#)/i.test(token.href)
        ) {
          token.href = "#";
        }
      },
    },
    // Recognises maths; nonStandard also allows "($x$)" and "$x$,".
    markedKatex({ nonStandard: true, throwOnError: false }),
    {
      extensions: [
        {
          name: "inlineKatex",
          renderer: (token) =>
            renderMath(token.text, (token as MathToken).displayMode),
        },
        {
          name: "blockKatex",
          renderer: (token) => `${renderMath(token.text, true)}\n`,
        },
      ],
    }
  );
}

/** Model output -> Markdown the parser understands (\( \) -> $ $). */
export const prepareMarkdown = (markdown: string) =>
  normalizeMathDelimiters(markdown);
