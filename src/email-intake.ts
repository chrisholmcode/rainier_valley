// Inbound-email intake for vendor invoices (Charlie's, Caruso's, etc.).
//
// A Cloudflare Email Worker (deployed separately) receives mail sent to
// invoices@loadslip.com, parses the MIME, and POSTs a JSON envelope here.
// This handler runs the same extraction pipeline as the web bulk-upload
// path — the only new logic is HMAC verification, sender allowlisting, and
// persistent Message-ID dedup against the Processed Emails sheet tab.
//
// Trust model: the Worker validates SPF/DKIM before forwarding. This handler
// re-checks the sender against EMAIL_ALLOWED_SENDERS as belt-and-suspenders
// (in case the Worker allowlist and the app allowlist ever diverge) and
// verifies an HMAC-SHA256 signature over the raw request body so a leaked
// webhook URL isn't sufficient to inject rows.

import { createHmac, timingSafeEqual, createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { env } from "./config.js";
import {
  processInvoiceFile,
  storePhoto,
  buildUploadPhotoUrl,
  withBulkUploadSlot,
  type UploadedFileResult
} from "./bulk-upload.js";
import { preflightImageBuffer, ImagePreflightError } from "./image-preflight.js";
import {
  appendProcessedEmailRow,
  ensureProcessedEmailsHeader,
  findProcessedEmailByMessageId,
  ensureSheetHeader,
  ensureSummarySheetHeader,
  ensureCorrectionsLogHeader,
  ensureExtractionTracesHeader,
  type ProcessedEmailResult
} from "./sheets.js";

// One email may carry multiple PDFs. Cap generously; individual attachment
// size is still bounded by the extraction pipeline's own 10 MB base64 cap.
const MAX_BODY_BYTES = 30 * 1024 * 1024;

const ACCEPTED_MIMES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/i;
const ACCEPTED_EXT = /\.(pdf|jpg|jpeg|png|webp|heic|heif|gif)$/i;

// Belt-and-suspenders with the Worker: if a forwarder mis-typed a real PDF
// (Outlook loves application/octet-stream), fall back to the filename ext
// and coerce to the canonical MIME so the downstream extractor accepts it.
export function normalizeMime(mimeType: string, filename: string): string | null {
  if (ACCEPTED_MIMES.test(mimeType)) return mimeType;
  const m = filename.match(ACCEPTED_EXT);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  return `image/${ext}`;
}

const InboundAttachmentSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  contentBase64: z.string().min(1)
});

const InboundEmailSchema = z.object({
  messageId: z.string().min(1),
  from: z.string().min(1),
  subject: z.string().default(""),
  receivedAt: z.string().optional(),
  // Optional attribution headers for the forwarded-mail case. When the sender
  // was rewritten by the forwarder (SRS, VERP), these recover the real sender.
  // Precedence: replyTo > originalSender > SRS-decode(from) > from.
  replyTo: z.string().optional(),
  originalSender: z.string().optional(),
  attachments: z.array(InboundAttachmentSchema).min(1)
});

type InboundEmailBody = z.infer<typeof InboundEmailSchema>;

interface AttachmentOutcome {
  filename: string;
  sha256: string;
  result: ProcessedEmailResult;
  supplier: string | null;
  invoiceOrOrderNumber: string | null;
  rowsAdded: number;
  avgConfidence: number | null;
  photoUrl: string | null;
  warnings: string[];
  error: string | null;
}

// ── Auth helpers ───────────────────────────────────────────────────────────

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Payload too large (${(total / 1_048_576).toFixed(1)} MB > ${MAX_BODY_BYTES / 1_048_576} MB)`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

export function verifyHmac(rawBody: Buffer, headerSig: string | undefined, secret: string): boolean {
  if (!headerSig) return false;
  const provided = headerSig.startsWith("sha256=") ? headerSig.slice("sha256=".length) : headerSig;
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

// Parse `Name <addr@host>` or bare `addr@host`. Returns lowercase address or
// null. Rejects obviously malformed input (no @, whitespace inside address).
function extractEmailAddress(from: string): string | null {
  const angle = from.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : from).trim().toLowerCase();
  if (!candidate.includes("@") || /\s/.test(candidate)) return null;
  return candidate;
}

// Decode a Sender Rewriting Scheme envelope address back to the original
// sender. Handles the plaintext variants:
//   SRS0=HHH=TT=domain=local@forwarder
//   SRS1=XXX=hop==HHH=TT=domain=local@forwarder
//   bounces+SRS=HHH=TT=domain=local@forwarder
// Returns `local@domain` or null if the SRS portion is opaque (HMAC-sealed,
// no plaintext domain/local) or the string isn't SRS at all.
export function decodeSrsAddress(addr: string): string | null {
  const inner = addr.match(/SRS[01]?=([^@]+)@/i);
  if (!inner) return null;
  const parts = inner[1].split("=");
  if (parts.length < 4) return null;
  const local = parts[parts.length - 1];
  const domain = parts[parts.length - 2];
  if (!local || !domain || !/\./.test(domain)) return null;
  return `${local}@${domain}`.toLowerCase();
}

// `bounces+SRS=xxx@domain` with no plaintext sender embedded (just a sealed
// HMAC hash). We can't recover the original sender, but we can at least label
// the forwarder.
export function isOpaqueSrsBounce(addr: string): boolean {
  if (!/SRS[01]?=/i.test(addr)) return false;
  return decodeSrsAddress(addr) === null;
}

// Human-readable placeholder for an opaque SRS bounce. Returns
// `forwarded-via@<forwarder-domain>` so attribution still identifies the
// forwarder even when we can't recover the real sender.
export function labelOpaqueSrsBounce(addr: string): string | null {
  if (!isOpaqueSrsBounce(addr)) return null;
  const at = addr.lastIndexOf("@");
  if (at < 0) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  if (!domain || !/\./.test(domain)) return null;
  return `forwarded-via@${domain}`;
}

// Resolve the best "who really sent this" address for `uploaded_by`. Honors
// Reply-To / X-Original-Sender when the forwarder passes them through, then
// decodes plaintext SRS, then falls back to a forwarder label for opaque SRS,
// and only uses the raw envelope sender as a last resort.
export function resolveOriginalSender(body: {
  from: string;
  replyTo?: string;
  originalSender?: string;
}): string {
  const candidates = [body.replyTo, body.originalSender]
    .map((s) => (s ? extractEmailAddress(s) : null))
    .filter((s): s is string => !!s);
  if (candidates[0]) return candidates[0];
  const envelope = extractEmailAddress(body.from) ?? body.from;
  const srs = decodeSrsAddress(envelope);
  if (srs) return srs;
  const label = labelOpaqueSrsBounce(envelope);
  if (label) return label;
  return envelope;
}

// Allowlist patterns: exact address, `@domain.com`, or `*@domain.com`. All
// compared lowercase. Empty allowlist rejects everything (fail-closed).
export function isSenderAllowed(from: string, allowlistCsv: string): boolean {
  const addr = extractEmailAddress(from);
  if (!addr) return false;
  const domain = addr.split("@")[1];
  const patterns = allowlistCsv.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  return patterns.some((p) => {
    if (p.startsWith("*@")) return domain === p.slice(2);
    if (p.startsWith("@")) return domain === p.slice(1);
    return addr === p;
  });
}

// ── Attachment processing ──────────────────────────────────────────────────

async function processAttachment(params: {
  attachment: z.infer<typeof InboundAttachmentSchema>;
  from: string;
}): Promise<AttachmentOutcome> {
  const { attachment, from } = params;
  const bytes = Buffer.from(attachment.contentBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const base: Omit<AttachmentOutcome, "result" | "error"> = {
    filename: attachment.filename,
    sha256,
    supplier: null,
    invoiceOrOrderNumber: null,
    rowsAdded: 0,
    avgConfidence: null,
    photoUrl: null,
    warnings: []
  };

  const normalizedMime = normalizeMime(attachment.mimeType, attachment.filename);
  if (!normalizedMime) {
    return { ...base, result: "unsupported_mime", error: `Unsupported MIME: ${attachment.mimeType} (filename ${attachment.filename})` };
  }

  let imageBytes: Buffer;
  let mimeType: string;
  try {
    const preflighted = await preflightImageBuffer(bytes, normalizedMime, attachment.filename);
    imageBytes = preflighted.buffer;
    mimeType = preflighted.mimeType;
  } catch (err) {
    if (err instanceof ImagePreflightError) {
      return { ...base, result: "extraction_failed", error: err.message };
    }
    throw err;
  }

  await storePhoto(sha256, mimeType, imageBytes);
  const photoUrl = buildUploadPhotoUrl(sha256);
  const slackMessageTs = `${Date.now()}-${sha256.slice(0, 8)}`;

  let result: UploadedFileResult;
  try {
    result = await processInvoiceFile({
      input: {
        filename: attachment.filename,
        mimeType,
        bytes: imageBytes,
        uploadedBy: `email:${from}`
      },
      imageBytes,
      mimeType,
      photoUrl,
      slackMessageTs
    });
  } catch (err) {
    return {
      ...base,
      photoUrl,
      result: "extraction_failed",
      error: (err as Error).message
    };
  }

  // rowsAdded === 0 with duplicateReason === "sheet" is the persistent-dedup
  // signal from appendExtractionRows (same supplier+invoice or same photo_url
  // already in the sheet). Preserve that as a distinct terminal state so the
  // audit tab tells a reviewer *why* nothing landed.
  const isSheetDup = result.rowsAdded === 0 && result.duplicateReason === "sheet";

  return {
    filename: attachment.filename,
    sha256,
    result: isSheetDup ? "dedup_sheet" : "processed",
    supplier: result.supplier,
    invoiceOrOrderNumber: result.invoiceNumber,
    rowsAdded: result.rowsAdded,
    avgConfidence: result.avgConfidence,
    photoUrl,
    warnings: result.warnings,
    error: null
  };
}

// ── HTTP handler ───────────────────────────────────────────────────────────

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleInboundEmailRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = env.EMAIL_INTAKE_SECRET;
  const allowlist = env.EMAIL_ALLOWED_SENDERS;
  if (!secret || !allowlist) {
    writeJson(res, 503, { ok: false, error: "Email intake not configured (EMAIL_INTAKE_SECRET and EMAIL_ALLOWED_SENDERS required)" });
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    writeJson(res, 413, { ok: false, error: (err as Error).message });
    return;
  }

  const sigHeader = req.headers["x-loadslip-signature"];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!verifyHmac(rawBody, sig, secret)) {
    writeJson(res, 401, { ok: false, error: "Invalid or missing X-Loadslip-Signature" });
    return;
  }

  let body: InboundEmailBody;
  try {
    body = InboundEmailSchema.parse(JSON.parse(rawBody.toString("utf8")));
  } catch (err) {
    writeJson(res, 400, { ok: false, error: `Invalid body: ${(err as Error).message}` });
    return;
  }

  if (!isSenderAllowed(body.from, allowlist)) {
    writeJson(res, 403, { ok: false, error: `Sender not in allowlist: ${body.from}` });
    return;
  }

  const receivedAt = body.receivedAt ?? new Date().toISOString();

  // Layer 1 dedup: Message-ID against the Processed Emails tab. Short-circuits
  // Cloudflare/Postmark webhook retries and forwarding loops. Content-hash and
  // supplier+invoice# dedup happen downstream inside processInvoiceFile.
  await ensureProcessedEmailsHeader();
  const prior = await findProcessedEmailByMessageId(body.messageId);
  if (prior) {
    console.log(`[email-intake] dedup message_id=${body.messageId} priorReceivedAt=${prior.receivedAt}`);
    writeJson(res, 200, {
      ok: true,
      messageId: body.messageId,
      dedup: { messageId: body.messageId, priorReceivedAt: prior.receivedAt },
      processed: []
    });
    return;
  }

  // Reuse the bulk-upload semaphore so email + web uploads share a concurrency
  // budget against the Anthropic API.
  const outcomes = await withBulkUploadSlot(async () => {
    // Ensure downstream sheet headers once per request instead of per attachment.
    await ensureSheetHeader();
    await ensureSummarySheetHeader();
    await ensureCorrectionsLogHeader();
    await ensureExtractionTracesHeader();

    const attribution = resolveOriginalSender(body);
    const results: AttachmentOutcome[] = [];
    for (const attachment of body.attachments) {
      const started = Date.now();
      const outcome = await processAttachment({ attachment, from: attribution });
      const durMs = Date.now() - started;
      console.log(`[email-intake] file=${attachment.filename} result=${outcome.result} rows=${outcome.rowsAdded} supplier=${outcome.supplier ?? "?"} attribution=${attribution} dur=${durMs}ms`);
      results.push(outcome);
    }
    return results;
  });

  // Log one row per attachment so the audit trail is line-level, not envelope-level.
  for (const outcome of outcomes) {
    try {
      await appendProcessedEmailRow({
        receivedAt,
        messageId: body.messageId,
        from: body.from,
        subject: body.subject,
        attachmentFilename: outcome.filename,
        attachmentSha256: outcome.sha256,
        result: outcome.result,
        supplier: outcome.supplier,
        invoiceOrOrderNumber: outcome.invoiceOrOrderNumber,
        rowsAdded: outcome.rowsAdded,
        photoUrl: outcome.photoUrl,
        error: outcome.error
      });
    } catch (err) {
      console.warn(`[email-intake] appendProcessedEmailRow failed message_id=${body.messageId} file=${outcome.filename}: ${(err as Error).message}`);
    }
  }

  writeJson(res, 200, {
    ok: true,
    messageId: body.messageId,
    processed: outcomes.map((o) => ({
      filename: o.filename,
      result: o.result,
      supplier: o.supplier,
      invoiceOrOrderNumber: o.invoiceOrOrderNumber,
      rowsAdded: o.rowsAdded,
      avgConfidence: o.avgConfidence,
      warnings: o.warnings,
      error: o.error
    }))
  });
}
