// Slip-photo store. Two backends:
//
// 1. R2 (Cloudflare object storage) — configured via R2_* env vars. Durable,
//    survives container restarts, ~30-100ms per read/write. Preferred.
// 2. In-memory Map — fallback for dev/test/unset envs. 24h TTL, wiped on
//    container restart. Never suitable for prod audit.
//
// Backend selection happens once at import based on env. Callers see one
// async API and don't care which store is behind it.
//
// URL format is the same in both cases (`https://loadslip.upload/<hash>`) so
// existing sheet rows round-trip through both backends interchangeably.

import type { ServerResponse } from "node:http";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { env } from "./config.js";

const UPLOAD_HOST = "loadslip.upload";
const IN_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredPhoto {
  mimeType: string;
  bytes: Buffer;
  expiresAt: number;
}

export function buildUploadPhotoUrl(hash: string): string {
  return `https://${UPLOAD_HOST}/${hash}`;
}

function hashFromUrl(photoUrl: string): string | null {
  const prefix = `https://${UPLOAD_HOST}/`;
  if (!photoUrl.startsWith(prefix)) return null;
  return photoUrl.slice(prefix.length);
}

// ── R2 backend ─────────────────────────────────────────────────────────────

const r2Configured = Boolean(
  env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_ENDPOINT && env.R2_BUCKET
);

const r2Client = r2Configured
  ? new S3Client({
      region: "auto",
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!
      }
    })
  : null;

async function r2Put(hash: string, mimeType: string, bytes: Buffer): Promise<void> {
  if (!r2Client) throw new Error("R2 not configured");
  await r2Client.send(new PutObjectCommand({
    Bucket: env.R2_BUCKET!,
    Key: hash,
    Body: bytes,
    ContentType: mimeType
  }));
}

async function r2Get(hash: string): Promise<{ mimeType: string; bytes: Buffer } | null> {
  if (!r2Client) return null;
  try {
    const resp = await r2Client.send(new GetObjectCommand({ Bucket: env.R2_BUCKET!, Key: hash }));
    if (!resp.Body) return null;
    const chunks: Uint8Array[] = [];
    // Body is a Readable in Node; iterate to Buffer.
    for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return {
      mimeType: resp.ContentType ?? "application/octet-stream",
      bytes: Buffer.concat(chunks)
    };
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// ── In-memory backend (fallback) ───────────────────────────────────────────

const memStore = new Map<string, StoredPhoto>();

setInterval(() => {
  const now = Date.now();
  for (const [hash, p] of memStore.entries()) {
    if (p.expiresAt < now) memStore.delete(hash);
  }
}, 60 * 60 * 1000).unref();

// ── Public API ─────────────────────────────────────────────────────────────

export async function storePhoto(hash: string, mimeType: string, bytes: Buffer): Promise<void> {
  if (r2Configured) {
    try {
      await r2Put(hash, mimeType, bytes);
      return;
    } catch (err) {
      // Fall back to in-memory so the current request still has a servable
      // photo (matters for the review-UI-opened-immediately case). Next
      // restart drops it — R2 write failures need to be surfaced separately.
      console.warn(`[photo-store] R2 put failed for ${hash}, falling back to in-memory: ${(err as Error).message}`);
    }
  }
  memStore.set(hash, { mimeType, bytes, expiresAt: Date.now() + IN_MEMORY_TTL_MS });
}

// Returns true if the URL matches our upload host — regardless of whether we
// actually served the bytes. False means the caller should try a different
// backend (e.g., Slack fetch).
export async function tryServeUploadedPhoto(photoUrl: string, res: ServerResponse): Promise<boolean> {
  const hash = hashFromUrl(photoUrl);
  if (!hash) return false;

  // R2 first (durable). In-memory as a hot-cache / fallback.
  if (r2Configured) {
    try {
      const obj = await r2Get(hash);
      if (obj) {
        res.writeHead(200, { "Content-Type": obj.mimeType, "Cache-Control": "private, max-age=3600" });
        res.end(obj.bytes);
        return true;
      }
    } catch (err) {
      console.warn(`[photo-store] R2 get failed for ${hash}: ${(err as Error).message}`);
    }
  }

  const p = memStore.get(hash);
  if (p) {
    res.writeHead(200, { "Content-Type": p.mimeType, "Cache-Control": "private, max-age=3600" });
    res.end(p.bytes);
    return true;
  }

  res.writeHead(410, { "Content-Type": "text/plain" });
  res.end(
    r2Configured
      ? "Photo not found. It may have been deleted from storage."
      : "Uploaded photo has expired (24h retention). Re-upload the slip if you need to review the source image."
  );
  return true;
}
