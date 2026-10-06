import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import {
  DocumentReadError,
  detectDocumentKind,
  extractDocumentText,
} from "@/lib/documents/extract";
import { audioExtension, normalizeAudioType } from "@/lib/voice-message";

/** Images are scaled down in the browser first (lib/image-compress.ts). */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
/**
 * Without Vercel Blob storage, images are embedded in the message as data
 * URLs instead. That keeps uploads working, but the image is stored with the
 * chat, so it is limited to a smaller size.
 */
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= MAX_UPLOAD_BYTES, {
      message: "Image is too large. Please choose one under 4 MB.",
    })
    .refine((file) => ["image/jpeg", "image/png"].includes(file.type), {
      message: "Please upload a JPEG or PNG image.",
    }),
});

/**
 * Text kept from an uploaded document (about 40-60 pages). Longer files are
 * cut here; the chat route trims further per model.
 */
const MAX_DOCUMENT_CHARS = 150_000;

const isImage = (file: Blob) => file.type.startsWith("image/");

const stripControlCharacters = (text: string) =>
  Array.from(text)
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("");

/**
 * PDF, Word and text files are turned into text right away, and the text is
 * returned as a `text/plain` data URL that travels with the message. The
 * file itself isn't stored, so no Blob store is needed and big PDFs don't
 * hit Vercel's request size limit later.
 */
async function handleDocument(file: Blob) {
  const name =
    stripControlCharacters(
      file instanceof File && file.name ? file.name : "document"
    )
      .replace(/["<>\\/]/g, "_")
      .slice(-100) || "document";
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error:
          "This file is too large. Please choose one under 4 MB, or upload only the pages you need.",
      },
      { status: 413 }
    );
  }
  const data = new Uint8Array(await file.arrayBuffer());
  const kind = detectDocumentKind({ data, mediaType: file.type, name });
  if (kind === "unsupported") {
    return NextResponse.json(
      {
        error:
          "Please upload an image (JPEG or PNG), a PDF, a Word (.docx) file or a text file.",
      },
      { status: 400 }
    );
  }
  try {
    const { pages, text } = await extractDocumentText({
      data,
      mediaType: file.type,
      name,
    });
    const kept =
      text.length > MAX_DOCUMENT_CHARS
        ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[… the rest of the document was too long to attach.]`
        : text;
    return NextResponse.json({
      characters: text.length,
      contentType: "text/plain",
      pages,
      pathname: name,
      url: `data:text/plain;charset=utf-8;base64,${Buffer.from(kept, "utf8").toString("base64")}`,
    });
  } catch (error) {
    if (error instanceof DocumentReadError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    throw error;
  }
}

/** Don't keep the student waiting if Blob storage is slow or unreachable. */
const BLOB_TIMEOUT_MS = 15_000;

let warnedNoBlobStore = false;

/** Stores the image in Vercel Blob, or returns null if that isn't possible. */
async function uploadToBlob(
  name: string,
  data: ArrayBuffer,
  contentType?: string
) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    if (!warnedNoBlobStore) {
      warnedNoBlobStore = true;
      console.warn(
        "Image upload: BLOB_READ_WRITE_TOKEN is not set (no Vercel Blob store connected), so images are embedded in messages instead."
      );
    }
    return null;
  }
  try {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // @vercel/blob retries internally and may not stop on abort, so the
    // wait is capped here as well.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${BLOB_TIMEOUT_MS / 1000}s`));
      }, BLOB_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        put(name, data, {
          abortSignal: controller.signal,
          access: "public",
          addRandomSuffix: true,
          ...(contentType ? { contentType } : {}),
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // Visible in Vercel's function logs (e.g. invalid token, private store).
    console.error(
      "Image upload: Vercel Blob failed, embedding the image instead:",
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

/** A voice message recording, stored for playback in the chat. */
async function handleVoiceRecording(file: Blob) {
  const type = normalizeAudioType(file.type);
  if (!type) {
    return NextResponse.json(
      { error: "This browser recorded an audio format that isn't supported." },
      { status: 400 }
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "The voice message is too long. Please keep it shorter." },
      { status: 413 }
    );
  }
  const name = `voice-message.${audioExtension(type)}`;
  const data = await file.arrayBuffer();
  const blob = await uploadToBlob(name, data, type);
  if (blob) {
    return NextResponse.json({ ...blob, contentType: type, pathname: name });
  }
  if (file.size > MAX_INLINE_BYTES) {
    return NextResponse.json(
      { error: "The voice message is too long. Please keep it shorter." },
      { status: 413 }
    );
  }
  return NextResponse.json({
    contentType: type,
    pathname: name,
    url: `data:${type};base64,${Buffer.from(data).toString("base64")}`,
  });
}

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json(
      { error: "Please sign in again to upload files." },
      { status: 401 }
    );
  }

  if (request.body === null) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    if (file.type.startsWith("audio/")) {
      return await handleVoiceRecording(file);
    }

    if (!isImage(file)) {
      return await handleDocument(file);
    }

    const validatedFile = FileSchema.safeParse({ file });

    if (!validatedFile.success) {
      const errorMessage = validatedFile.error.issues
        .map((error) => error.message)
        .join(", ");

      return NextResponse.json({ error: errorMessage }, { status: 400 });
    }

    const filename = file instanceof File && file.name ? file.name : "image";
    // Attachment names are limited to 100 characters in chat messages.
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
    const fileBuffer = await file.arrayBuffer();

    const blob = await uploadToBlob(safeName, fileBuffer);
    if (blob) {
      return NextResponse.json(blob);
    }

    if (file.size > MAX_INLINE_BYTES) {
      return NextResponse.json(
        { error: "Image is too large. Please choose one under 2 MB." },
        { status: 413 }
      );
    }

    const base64 = Buffer.from(fileBuffer).toString("base64");
    return NextResponse.json({
      contentType: file.type,
      pathname: safeName,
      url: `data:${file.type};base64,${base64}`,
    });
  } catch (error) {
    console.error(
      "Upload failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "Couldn't upload the file. Please try again." },
      { status: 500 }
    );
  }
}
