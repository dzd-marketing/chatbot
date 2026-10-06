"use client";

import {
  defaultMarkdownSerializer,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import { DOMParser, type Node } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import {
  createMarkdown,
  escapeHtml,
  prepareMarkdown,
} from "@/lib/markdown/marked";

import { documentSchema } from "./config";
import type { UISuggestion } from "./suggestions";

/** Maths becomes placeholders that the editor's math nodes pick up. */
const documentMarkdown = createMarkdown((tex, displayMode) =>
  displayMode
    ? `<div data-math-display data-tex="${escapeHtml(tex)}"></div>`
    : `<span data-math-inline data-tex="${escapeHtml(tex)}"></span>`
);

/** Markdown -> DOM in an inert document (nothing in it runs or loads). */
export const markdownToDom = (content: string) => {
  const html = documentMarkdown.parse(prepareMarkdown(content)) as string;
  return new window.DOMParser().parseFromString(html, "text/html").body;
};

export const buildDocumentFromContent = (content: string) =>
  DOMParser.fromSchema(documentSchema).parse(markdownToDom(content));

/** Text of a table cell on one line, with pipes escaped. */
function cellMarkdown(cell: Node) {
  return markdownSerializer
    .serialize(cell)
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function serializeTable(state: MarkdownSerializerState, node: Node) {
  const rows = node.children.map((row) => row.children.map(cellMarkdown));
  const width = Math.max(1, ...rows.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  const [header = [], ...body] = rows;
  state.write(
    [
      line(header),
      `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
      ...body.map(line),
    ].join("\n")
  );
  state.closeBlock(node);
}

/** Saves documents as Markdown, keeping maths and tables. */
const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    math_display(state, node) {
      state.write(`$$\n${node.attrs.tex}\n$$`);
      state.closeBlock(node);
    },
    math_inline(state, node) {
      state.write(`$${node.attrs.tex}$`);
    },
    table: serializeTable,
    // Rows and cells are written by `table`.
    table_cell() {
      // handled by serializeTable
    },
    table_header() {
      // handled by serializeTable
    },
    table_row() {
      // handled by serializeTable
    },
  },
  defaultMarkdownSerializer.marks
);

export const buildContentFromDocument = (document: Node) =>
  markdownSerializer.serialize(document);

export const createDecorations = (
  suggestions: UISuggestion[],
  _view: EditorView
) => {
  const decorations: Decoration[] = [];

  for (const suggestion of suggestions) {
    decorations.push(
      Decoration.inline(
        suggestion.selectionStart,
        suggestion.selectionEnd,
        {
          class: "suggestion-highlight",
          "data-suggestion-id": suggestion.id,
        },
        {
          suggestionId: suggestion.id,
          type: "highlight",
        }
      )
    );
  }

  return DecorationSet.create(_view.state.doc, decorations);
};
