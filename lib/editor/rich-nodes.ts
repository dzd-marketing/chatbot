import katex from "katex";
import type { NodeSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

/**
 * Extra node types for AI documents in the editor: maths (rendered with
 * KaTeX) and tables (prosemirror-tables). The Markdown -> HTML step
 * (lib/editor/functions.tsx) marks maths with data-math-* attributes.
 */

function renderMath(tex: string, displayMode: boolean) {
  const element = document.createElement(displayMode ? "div" : "span");
  element.className = displayMode ? "dzd-math-display" : "dzd-math-inline";
  element.setAttribute(
    displayMode ? "data-math-display" : "data-math-inline",
    ""
  );
  element.setAttribute("data-tex", tex);
  element.contentEditable = "false";
  try {
    katex.render(tex, element, { displayMode, throwOnError: false });
  } catch {
    element.textContent = tex;
  }
  return element;
}

const texFrom = (dom: HTMLElement | string) =>
  typeof dom === "string" ? {} : { tex: dom.getAttribute("data-tex") ?? "" };

export const mathNodes: Record<string, NodeSpec> = {
  math_display: {
    atom: true,
    attrs: { tex: { default: "" } },
    group: "block",
    parseDOM: [{ getAttrs: texFrom, tag: "div[data-math-display]" }],
    selectable: true,
    toDOM: (node) => renderMath(node.attrs.tex as string, true),
  },
  math_inline: {
    atom: true,
    attrs: { tex: { default: "" } },
    group: "inline",
    inline: true,
    parseDOM: [{ getAttrs: texFrom, tag: "span[data-math-inline]" }],
    selectable: true,
    toDOM: (node) => renderMath(node.attrs.tex as string, false),
  },
};

export const tableNodeSpecs = tableNodes({
  cellAttributes: {},
  cellContent: "block+",
  tableGroup: "block",
});
