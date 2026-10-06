import "server-only";

/**
 * Text extraction for documents students upload or DZD AI reads from the
 * web: PDF (unpdf, a serverless build of Mozilla's pdf.js), Word .docx
 * (mammoth) and plain text / Markdown. Scanned PDFs have no text layer, so
 * they produce an error asking for photos instead.
 */

export type DocumentKind = "pdf" | "docx" | "text";

export class DocumentReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DocumentReadError";
  }
}

const DOCX_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const startsWith = (data: Uint8Array, bytes: number[]) =>
  bytes.every((byte, index) => data[index] === byte);

/** Works out the document type from its bytes, media type and file name. */
export function detectDocumentKind({
  data,
  mediaType = "",
  name = "",
}: {
  data: Uint8Array;
  mediaType?: string;
  name?: string;
}): DocumentKind | "doc" | "unsupported" {
  const type = mediaType.toLowerCase().split(";")[0].trim();
  const lowerName = name.toLowerCase();
  // %PDF
  if (startsWith(data, [0x25, 0x50, 0x44, 0x46])) {
    return "pdf";
  }
  // ZIP container: .docx (also .xlsx/.pptx, which aren't supported).
  if (startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    return type === DOCX_TYPE || lowerName.endsWith(".docx")
      ? "docx"
      : "unsupported";
  }
  // Old binary Word / Office files.
  if (startsWith(data, [0xd0, 0xcf, 0x11, 0xe0])) {
    return "doc";
  }
  if (
    type.startsWith("text/plain") ||
    type === "text/markdown" ||
    /\.(txt|md|markdown)$/.test(lowerName)
  ) {
    return "text";
  }
  return "unsupported";
}

function tidy(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function pdfText(data: Uint8Array) {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js takes ownership of the buffer, so give it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(data));
  try {
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(text) ? text : [text];
    const body = pages
      .map((page, index) => {
        const content = tidy(page);
        return content ? `--- Page ${index + 1} ---\n${content}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
    return { pages: totalPages, text: body };
  } finally {
    // destroy() exists at runtime but is missing from unpdf's types.
    const disposable = pdf as unknown as { destroy?: () => Promise<void> };
    await (disposable.destroy?.() ?? pdf.cleanup()).catch(() => undefined);
  }
}

async function docxText(data: Uint8Array) {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({
    buffer: Buffer.from(data),
  });
  return { pages: undefined, text: tidy(value) };
}

/**
 * The text of a PDF, .docx or text file. Throws DocumentReadError with a
 * student-friendly message when the file can't be read.
 */
export async function extractDocumentText(input: {
  data: Uint8Array;
  mediaType?: string;
  name?: string;
}): Promise<{ kind: DocumentKind; pages?: number; text: string }> {
  const kind = detectDocumentKind(input);
  if (kind === "doc") {
    throw new DocumentReadError(
      "Old Word (.doc) files can't be read. Please save it as .docx or PDF and try again."
    );
  }
  if (kind === "unsupported") {
    throw new DocumentReadError(
      "This file type isn't supported. Please use a PDF, Word (.docx) or text file."
    );
  }

  let result: { pages?: number; text: string };
  try {
    if (kind === "pdf") {
      result = await pdfText(input.data);
    } else if (kind === "docx") {
      result = await docxText(input.data);
    } else {
      result = {
        text: tidy(new TextDecoder("utf-8").decode(input.data)),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password/i.test(message)) {
      throw new DocumentReadError(
        "This PDF is password-protected, so it can't be read.",
        { cause: error }
      );
    }
    throw new DocumentReadError(
      "This file couldn't be read. It may be damaged or in an unusual format.",
      { cause: error }
    );
  }

  if (!result.text) {
    throw new DocumentReadError(
      kind === "pdf"
        ? "This PDF has no readable text (it's probably scanned). Please send photos of the pages instead."
        : "This file has no readable text."
    );
  }
  return { kind, pages: result.pages, text: result.text };
}
