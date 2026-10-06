import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImportedXmlComponent,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import type { Token, Tokens } from "marked";
import {
  createMarkdown,
  type MathToken,
  prepareMarkdown,
} from "@/lib/markdown/marked";
import { texToOmml } from "./omml";

/**
 * Markdown (the format of DZD AI's text documents) -> Word .docx, in the
 * browser. Headings, paragraphs, bold/italic/strike/code, links, bullet and
 * numbered lists, tables, code blocks, quotes and rules are kept. Sinhala
 * and Tamil use "Nirmala UI" (included with Windows) as the complex-script
 * font. Maths becomes real Word equations (editable in Word); TeX that
 * can't be converted is kept as written.
 */

const FONT = {
  ascii: "Calibri",
  cs: "Nirmala UI",
  eastAsia: "Calibri",
  hAnsi: "Calibri",
};
const CODE_FONT = { ascii: "Consolas", cs: "Nirmala UI", hAnsi: "Consolas" };

type InlineStyle = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
};

type Inline = TextRun | ExternalHyperlink;

/** Only the tokenizer is used (with the maths extension). */
const markdown = createMarkdown((tex) => tex);

/**
 * A Word equation for the TeX, or the TeX as text if it can't be converted.
 * (docx's ParagraphChild type doesn't list imported XML; it works the same.)
 */
function equation(tex: string, displayMode: boolean, style: InlineStyle) {
  const omml = texToOmml(tex, displayMode);
  if (!omml) {
    return run(displayMode ? tex : `$${tex}$`, { ...style, code: true });
  }
  // fromXmlString returns a nameless wrapper; the equation is its child.
  const wrapper = ImportedXmlComponent.fromXmlString(omml) as unknown as {
    root?: unknown[];
  };
  const element = wrapper.root?.[0];
  if (!(element instanceof ImportedXmlComponent)) {
    return run(displayMode ? tex : `$${tex}$`, { ...style, code: true });
  }
  return element as unknown as TextRun;
}

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

/** Undo HTML entities that marked leaves in text tokens. */
function decode(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function run(text: string, style: InlineStyle, extra: { link?: boolean } = {}) {
  return new TextRun({
    bold: style.bold,
    font: style.code ? CODE_FONT : undefined,
    italics: style.italics,
    shading: style.code
      ? { fill: "EEF2F0", type: ShadingType.CLEAR }
      : undefined,
    strike: style.strike,
    style: extra.link ? "Hyperlink" : undefined,
    text,
  });
}

function inlines(
  tokens: Token[] | undefined,
  style: InlineStyle = {}
): Inline[] {
  if (!tokens) {
    return [];
  }
  return tokens.flatMap((token): Inline[] => {
    switch (token.type) {
      case "inlineKatex": {
        const math = token as MathToken;
        return [equation(math.text, math.displayMode, style)];
      }
      case "strong":
        return inlines(token.tokens, { ...style, bold: true });
      case "em":
        return inlines(token.tokens, { ...style, italics: true });
      case "del":
        return inlines(token.tokens, { ...style, strike: true });
      case "codespan":
        return [run(decode(token.text), { ...style, code: true })];
      case "br":
        return [new TextRun({ break: 1 })];
      case "link": {
        const { href } = token as Tokens.Link;
        const children = [run(decode(token.text), style, { link: true })];
        if (/^(https?:|mailto:)/i.test(href)) {
          return [new ExternalHyperlink({ children, link: href })];
        }
        return children;
      }
      case "image":
        return [run(`[Image: ${decode(token.text || token.href)}]`, style)];
      case "text":
      case "escape":
        return "tokens" in token && token.tokens?.length
          ? inlines(token.tokens, style)
          : [run(decode(token.text), style)];
      case "html":
        return [run(decode(token.text.replace(/<[^>]+>/g, "")), style)];
      default:
        return "text" in token && typeof token.text === "string"
          ? [run(decode(token.text), style)]
          : [];
    }
  });
}

type BlockContext = {
  /** Numbering instance counter, so each numbered list restarts at 1. */
  lists: { next: number };
  quote?: boolean;
};

function blocks(
  tokens: Token[],
  context: BlockContext,
  listLevel = 0
): (Paragraph | Table)[] {
  return tokens.flatMap((token): (Paragraph | Table)[] => {
    switch (token.type) {
      case "blockKatex":
        return [
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [equation((token as MathToken).text, true, {})],
            spacing: { after: 160, before: 80 },
          }),
        ];
      case "heading":
        return [
          new Paragraph({
            children: inlines(token.tokens),
            heading: HEADINGS[Math.min(token.depth, 6) - 1],
          }),
        ];
      case "paragraph":
        return [
          new Paragraph({
            border: context.quote
              ? {
                  left: {
                    color: "10B981",
                    size: 12,
                    space: 12,
                    style: BorderStyle.SINGLE,
                  },
                }
              : undefined,
            children: inlines(token.tokens),
            indent: context.quote ? { left: 480 } : undefined,
            spacing: { after: 160 },
          }),
        ];
      case "text":
        // Loose text directly inside list items.
        return [new Paragraph({ children: inlines(token.tokens ?? [token]) })];
      case "list":
        return list(token as Tokens.List, context, listLevel);
      case "code":
        return [
          new Paragraph({
            children: token.text
              .split("\n")
              .flatMap((line: string, index: number) => [
                ...(index > 0 ? [new TextRun({ break: 1 })] : []),
                new TextRun({ font: CODE_FONT, size: 19, text: line }),
              ]),
            shading: { fill: "F3F5F4", type: ShadingType.CLEAR },
            spacing: { after: 160 },
          }),
        ];
      case "blockquote":
        return blocks(
          token.tokens ?? [],
          { ...context, quote: true },
          listLevel
        );
      case "hr":
        return [
          new Paragraph({
            border: {
              bottom: {
                color: "BBBBBB",
                size: 6,
                space: 1,
                style: BorderStyle.SINGLE,
              },
            },
            children: [],
          }),
        ];
      case "table":
        return [table(token as Tokens.Table), new Paragraph({ children: [] })];
      case "html": {
        const text = decode(token.text.replace(/<[^>]+>/g, "")).trim();
        return text ? [new Paragraph({ children: [new TextRun(text)] })] : [];
      }
      default:
        return [];
    }
  });
}

function list(
  token: Tokens.List,
  context: BlockContext,
  level: number
): Paragraph[] {
  const instance = context.lists.next;
  context.lists.next += 1;
  return token.items.flatMap((item) => {
    // Task items start with a checkbox token (shown as ☑/☐ instead).
    const itemTokens = item.tokens.filter(
      (child) => (child.type as string) !== "checkbox"
    );
    const [first, ...rest] = itemTokens;
    const firstInline =
      first && (first.type === "text" || first.type === "paragraph")
        ? inlines(("tokens" in first && first.tokens) || [first])
        : [];
    const prefix = item.task ? [new TextRun(item.checked ? "☑ " : "☐ ")] : [];
    const head = new Paragraph({
      children: [...prefix, ...firstInline],
      ...(token.ordered
        ? {
            numbering: {
              instance,
              level: Math.min(level, 8),
              reference: "dzd-numbered",
            },
          }
        : { bullet: { level: Math.min(level, 8) } }),
    });
    const remaining = firstInline.length > 0 ? rest : itemTokens;
    const nested = blocks(remaining, context, level + 1).filter(
      (child): child is Paragraph => child instanceof Paragraph
    );
    return [head, ...nested];
  });
}

function table(token: Tokens.Table) {
  const alignment = (index: number) => {
    const align = token.align[index];
    if (align === "center") {
      return AlignmentType.CENTER;
    }
    if (align === "right") {
      return AlignmentType.RIGHT;
    }
    return AlignmentType.LEFT;
  };
  const cell = (content: Tokens.TableCell, index: number, header: boolean) =>
    new TableCell({
      children: [
        new Paragraph({
          alignment: alignment(index),
          children: inlines(content.tokens, { bold: header }),
        }),
      ],
      margins: { bottom: 60, left: 100, right: 100, top: 60 },
      shading: header ? { fill: "E7F6EF", type: ShadingType.CLEAR } : undefined,
    });
  return new Table({
    rows: [
      new TableRow({
        children: token.header.map((content, index) =>
          cell(content, index, true)
        ),
        tableHeader: true,
      }),
      ...token.rows.map(
        (row) =>
          new TableRow({
            children: row.map((content, index) => cell(content, index, false)),
          })
      ),
    ],
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

export function markdownToDocxDocument(title: string, source: string) {
  const tokens = markdown.lexer(prepareMarkdown(source));
  const startsWithTitle =
    tokens[0]?.type === "heading" && (tokens[0] as Tokens.Heading).depth === 1;
  const children = [
    ...(startsWithTitle
      ? []
      : [
          new Paragraph({
            children: [new TextRun(title)],
            heading: HeadingLevel.TITLE,
          }),
        ]),
    ...blocks(tokens, { lists: { next: 1 } }),
  ];

  return new Document({
    creator: "DZD Learn",
    numbering: {
      config: [
        {
          levels: Array.from({ length: 9 }, (_, level) => ({
            alignment: AlignmentType.START,
            format: [
              LevelFormat.DECIMAL,
              LevelFormat.LOWER_LETTER,
              LevelFormat.LOWER_ROMAN,
            ][level % 3],
            level,
            style: {
              paragraph: {
                indent: { hanging: 360, left: 720 * (level + 1) },
              },
            },
            text: `%${level + 1}.`,
          })),
          reference: "dzd-numbered",
        },
      ],
    },
    sections: [{ children }],
    styles: {
      default: {
        document: { run: { font: FONT, size: 22 } },
        heading1: { run: { color: "065F46", font: FONT } },
        heading2: { run: { color: "047857", font: FONT } },
        heading3: { run: { color: "047857", font: FONT } },
        title: { run: { color: "065F46", font: FONT } },
      },
    },
    title,
  });
}

export function markdownToDocx(title: string, source: string) {
  return Packer.toBlob(markdownToDocxDocument(title, source));
}
