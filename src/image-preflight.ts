import sharp from "sharp";

// Anthropic caps inline image data at 10 MB base64. Base64 inflates raw bytes
// by ~4/3, so raw > ~7.5 MB blows past the cap. We resize with margin.
const RAW_LIMIT_BYTES = 7_000_000;
const MAX_LONGEST_EDGE = 2000;
const JPEG_QUALITY = 80;

export interface PreflightResult {
  buffer: Buffer;
  mimeType: string;
  resized: boolean;
}

export class ImagePreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImagePreflightError";
  }
}

export async function preflightImageBuffer(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<PreflightResult> {
  if (!mimeType.startsWith("image/")) {
    return { buffer, mimeType, resized: false };
  }
  if (buffer.byteLength <= RAW_LIMIT_BYTES) {
    return { buffer, mimeType, resized: false };
  }

  const originalMb = (buffer.byteLength / 1_048_576).toFixed(2);
  const resized = await sharp(buffer)
    .rotate()
    .resize({ width: MAX_LONGEST_EDGE, height: MAX_LONGEST_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  if (resized.byteLength > RAW_LIMIT_BYTES) {
    throw new ImagePreflightError(
      `Image still too large after resize (${(resized.byteLength / 1_048_576).toFixed(2)} MB)`
    );
  }

  const resizedMb = (resized.byteLength / 1_048_576).toFixed(2);
  console.log(`[preflight] resized ${filename} ${originalMb}MB → ${resizedMb}MB (jpeg 2000px)`);
  return { buffer: resized, mimeType: "image/jpeg", resized: true };
}
