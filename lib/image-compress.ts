/**
 * Browser-side image preparation before upload: phone photos are often
 * several MB (and Vercel rejects request bodies over 4.5 MB), so images are
 * scaled down to at most MAX_SIDE pixels and re-encoded. Other formats the
 * browser can decode (WebP, HEIC on Safari, ...) become JPEG, which every
 * vision model accepts.
 */

const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.85;
/** Small JPEG/PNG files are uploaded as they are. */
const KEEP_AS_IS_BYTES = 600 * 1024;

const UPLOADABLE_TYPES = new Set(["image/jpeg", "image/png"]);

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This image format can't be opened"));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Couldn't compress image")),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

/**
 * A JPEG/PNG file ready to upload. Throws when the browser can't read the
 * image (for example HEIC outside Safari).
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  if (UPLOADABLE_TYPES.has(file.type) && file.size <= KEEP_AS_IS_BYTES) {
    return file;
  }

  const image = await loadImage(file);
  const scale = Math.min(
    1,
    MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight)
  );
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return file;
  }
  // JPEG has no transparency: put transparent PNGs on white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const blob = await canvasToBlob(canvas);
  // Keep the original if re-encoding didn't help (already small JPEG/PNG).
  if (UPLOADABLE_TYPES.has(file.type) && blob.size >= file.size) {
    return file;
  }
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  return new File([blob], `${baseName}.jpg`, { type: "image/jpeg" });
}
