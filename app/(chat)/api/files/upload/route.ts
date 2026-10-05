import { put } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";

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

/** Don't keep the student waiting if Blob storage is slow or unreachable. */
const BLOB_TIMEOUT_MS = 15_000;

let warnedNoBlobStore = false;

/** Stores the image in Vercel Blob, or returns null if that isn't possible. */
async function uploadToBlob(name: string, data: ArrayBuffer) {
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

export async function POST(request: Request) {
  const session = await auth();

  if (!session) {
    return NextResponse.json(
      { error: "Please sign in again to upload images." },
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
      "Image upload failed:",
      error instanceof Error ? error.message : error
    );
    return NextResponse.json(
      { error: "Couldn't upload the image. Please try again." },
      { status: 500 }
    );
  }
}
