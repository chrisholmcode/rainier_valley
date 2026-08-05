// Web bulk-upload flow. Runs the same per-file extraction pipeline as the
// Slack file_share handler (classify → invoice or whiteboard → sheet write)
// against files POSTed from the /review/upload page.
//
// Photos are held in a process-local Map with a 24h TTL and served through
// the existing /review/photo proxy. photo_url is written to the sheet as
// `https://loadslip.upload/<hash>` so it round-trips through the same
// slip-group logic as Slack uploads.
//
// Concurrency is capped server-side (see BULK_UPLOAD_CONCURRENCY) so a
// browser firing 30 requests at once doesn't stampede the Anthropic API.

import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { env } from "./config.js";
import {
  extractFromImage,
  extractFromWhiteboard,
  classifyImage,
  guessSupplierFromFilename,
  normalizeRescueSlip,
  ensureRescueSkeleton
} from "./extraction.js";
import { preflightImageBuffer, ImagePreflightError } from "./image-preflight.js";
import { reconcileWithCarusoCatalog } from "./carusoCatalog.js";
import {
  appendExtractionRows,
  appendSummaryRow,
  appendExtractionTrace,
  appendEodRows,
  ensureSheetHeader,
  ensureSummarySheetHeader,
  ensureCorrectionsLogHeader,
  ensureExtractionTracesHeader,
  ensureEodSheetHeader
} from "./sheets.js";
import type { Supplier } from "./types.js";

// ── Photo store ────────────────────────────────────────────────────────────

const UPLOAD_HOST = "loadslip.upload";
const PHOTO_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredPhoto {
  mimeType: string;
  bytes: Buffer;
  expiresAt: number;
}

const photoStore = new Map<string, StoredPhoto>();

setInterval(() => {
  const now = Date.now();
  for (const [hash, p] of photoStore.entries()) {
    if (p.expiresAt < now) photoStore.delete(hash);
  }
}, 60 * 60 * 1000).unref();

// Session-scoped dedupe: re-uploading the exact same file within one server
// process returns the prior result instead of logging a second copy. Cleared
// on restart, same shape as the Slack handler's `processedContentHashes`.
const processedHashes = new Map<string, UploadedFileResult>();

function storePhoto(hash: string, mimeType: string, bytes: Buffer): void {
  photoStore.set(hash, { mimeType, bytes, expiresAt: Date.now() + PHOTO_TTL_MS });
}

export function buildUploadPhotoUrl(hash: string): string {
  return `https://${UPLOAD_HOST}/${hash}`;
}

export function tryServeUploadedPhoto(photoUrl: string, res: ServerResponse): boolean {
  if (!photoUrl.startsWith(`https://${UPLOAD_HOST}/`)) return false;
  const hash = photoUrl.slice(`https://${UPLOAD_HOST}/`.length);
  const p = photoStore.get(hash);
  if (!p) {
    res.writeHead(410, { "Content-Type": "text/plain" });
    res.end("Uploaded photo has expired (24h retention). Re-upload the slip if you need to review the source image.");
    return true;
  }
  res.writeHead(200, {
    "Content-Type": p.mimeType,
    "Cache-Control": "private, max-age=3600"
  });
  res.end(p.bytes);
  return true;
}

// ── Concurrency semaphore ──────────────────────────────────────────────────

const BULK_UPLOAD_CONCURRENCY = 3;

class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

const semaphore = new Semaphore(BULK_UPLOAD_CONCURRENCY);

// ── Single-file processing ─────────────────────────────────────────────────

const ACCEPTED_MIMES = /^(image\/(jpeg|png|webp|heic|heif|gif)|application\/pdf)$/i;

interface UploadedFileInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  uploadedBy: string;
}

interface UploadedFileResult {
  ok: true;
  kind: "invoice" | "whiteboard";
  supplier: Supplier | null;
  invoiceNumber: string | null;
  lineItems: number;
  avgConfidence: number;
  warnings: string[];
  rowsAdded: number;
  photoUrl: string;
  duplicateOfHash?: string;
  // `sheet` = sheets.ts dedupe hit (same supplier+invoice already in sheet)
  // `session` = same file already uploaded this process session
  duplicateReason?: "sheet" | "session";
}

interface UploadedFileError {
  ok: false;
  error: string;
}

async function processInvoiceFile(params: {
  input: UploadedFileInput;
  imageBytes: Buffer;
  mimeType: string;
  photoUrl: string;
  slackMessageTs: string;
}): Promise<UploadedFileResult> {
  const { input, imageBytes, mimeType, photoUrl, slackMessageTs } = params;

  const supplierHint = guessSupplierFromFilename(input.filename);
  const { result: extraction, trace } = await extractFromImage({
    imageBytes,
    mimeType,
    filename: input.filename,
    supplierHint
  });

  const carusoRec = reconcileWithCarusoCatalog(extraction);
  if (carusoRec.hits > 0) {
    console.log(`caruso catalog reconcile web-upload file=${input.filename} hits=${carusoRec.hits} overwrites=${carusoRec.overwrites}`);
  }

  appendExtractionTrace({
    trace,
    extraction,
    photoUrl,
    carusoReconcileHits: carusoRec.hits,
    carusoReconcileOverwrites: carusoRec.overwrites
  }).catch((err) => {
    console.warn(`appendExtractionTrace failed web-upload file=${input.filename}: ${(err as Error).message}`);
  });

  if (!extraction.delivery_date) {
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).format(new Date());
    extraction.delivery_date = today;
    extraction.source_warnings.push(
      `delivery_date not found on document — defaulted to upload date (${today})`
    );
  }

  if (!extraction.destination_org || !extraction.destination_org.trim()) {
    extraction.destination_org = env.TENANT_NAME;
    extraction.source_warnings.push(
      `destination_org not found on document — defaulted to ${env.TENANT_NAME}`
    );
  }

  normalizeRescueSlip(extraction);
  ensureRescueSkeleton(extraction);

  await ensureSheetHeader();
  await ensureSummarySheetHeader();
  await ensureCorrectionsLogHeader();
  await ensureExtractionTracesHeader();

  const rowsAdded = await appendExtractionRows({
    extraction,
    photoUrl,
    slackChannel: "web-upload",
    slackMessageTs,
    uploadedBy: input.uploadedBy
  });
  // rowsAdded === 0 means sheets.ts skipped the write because the (supplier,
  // invoice#) or photo_url was already logged. Skip the summary row too so
  // we don't add a phantom rollup for a slip that isn't actually there.
  const isSheetDuplicate = rowsAdded === 0;
  if (!isSheetDuplicate) {
    await appendSummaryRow({ extraction, photoUrl });
  }

  const totalConf = extraction.line_items.reduce((s, li) => s + li.confidence, 0);
  const avgConfidence = extraction.line_items.length > 0 ? totalConf / extraction.line_items.length : 0;

  return {
    ok: true,
    kind: "invoice",
    supplier: extraction.supplier,
    invoiceNumber: extraction.invoice_or_order_number,
    lineItems: extraction.line_items.length,
    avgConfidence,
    warnings: extraction.source_warnings,
    rowsAdded,
    photoUrl,
    ...(isSheetDuplicate ? { duplicateReason: "sheet" as const } : {})
  };
}

async function processWhiteboardFile(params: {
  input: UploadedFileInput;
  imageBytes: Buffer;
  mimeType: string;
  photoUrl: string;
  slackMessageTs: string;
}): Promise<UploadedFileResult> {
  const { input, imageBytes, mimeType, photoUrl, slackMessageTs } = params;

  const extraction = await extractFromWhiteboard({
    imageBytes,
    mimeType,
    filename: input.filename
  });

  const confidences = extraction.line_items
    .map((li) => li.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const minConf = confidences.length ? Math.min(...confidences) : null;
  const autoApprove = minConf !== null && minConf >= env.REVIEW_CONFIDENCE_THRESHOLD;

  await ensureEodSheetHeader();
  const rowsAdded = await appendEodRows({
    extraction,
    source: "whiteboard",
    slackChannel: "web-upload",
    slackMessageTs,
    recordedBy: input.uploadedBy,
    photoUrl,
    autoApprove
  });

  const totalConf = extraction.line_items.reduce((s, li) => s + li.confidence, 0);
  const avgConfidence = extraction.line_items.length > 0 ? totalConf / extraction.line_items.length : 0;

  return {
    ok: true,
    kind: "whiteboard",
    supplier: null,
    invoiceNumber: null,
    lineItems: extraction.line_items.length,
    avgConfidence,
    warnings: extraction.source_warnings,
    rowsAdded,
    photoUrl
  };
}

async function processOne(input: UploadedFileInput): Promise<UploadedFileResult | UploadedFileError> {
  if (!ACCEPTED_MIMES.test(input.mimeType)) {
    return { ok: false, error: `Unsupported file type: ${input.mimeType}` };
  }

  const contentHash = createHash("sha256").update(input.bytes).digest("hex");

  const prior = processedHashes.get(contentHash);
  if (prior) {
    return { ...prior, duplicateOfHash: contentHash, duplicateReason: "session" };
  }

  let imageBytes: Buffer;
  let mimeType: string;
  try {
    const preflighted = await preflightImageBuffer(input.bytes, input.mimeType, input.filename);
    imageBytes = preflighted.buffer;
    mimeType = preflighted.mimeType;
  } catch (err) {
    if (err instanceof ImagePreflightError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }

  storePhoto(contentHash, mimeType, imageBytes);
  const photoUrl = buildUploadPhotoUrl(contentHash);
  // Unique per-file: multiple uploads in the same ms still get distinct ts.
  const slackMessageTs = `${Date.now()}-${contentHash.slice(0, 8)}`;

  const kind = await classifyImage({ imageBytes, mimeType });
  console.log(`[web-upload] classified ${input.filename} as: ${kind}`);

  const result = kind === "whiteboard"
    ? await processWhiteboardFile({ input, imageBytes, mimeType, photoUrl, slackMessageTs })
    : await processInvoiceFile({ input, imageBytes, mimeType, photoUrl, slackMessageTs });
  processedHashes.set(contentHash, result);
  return result;
}

// ── HTTP handlers ──────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB per file upload

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error(`Payload too large (${(total / 1_048_576).toFixed(1)} MB > 25 MB)`);
    }
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export async function handleBulkUploadPageRequest(res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(BULK_UPLOAD_HTML);
}

export async function handleBulkUploadOneRequest(
  req: IncomingMessage,
  res: ServerResponse,
  uploadedBy: string
): Promise<void> {
  interface UploadOneBody {
    filename: string;
    mimeType: string;
    contentBase64: string;
  }

  let body: UploadOneBody;
  try {
    body = await readJsonBody<UploadOneBody>(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }

  if (!body.filename || !body.mimeType || !body.contentBase64) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "filename, mimeType, and contentBase64 are required" }));
    return;
  }

  const release = await semaphore.acquire();
  try {
    const bytes = Buffer.from(body.contentBase64, "base64");
    const started = Date.now();
    const result = await processOne({
      filename: body.filename,
      mimeType: body.mimeType,
      bytes,
      uploadedBy
    });
    const durMs = Date.now() - started;
    console.log(`[web-upload] file=${body.filename} ok=${result.ok} ${result.ok ? `kind=${result.kind} rows=${result.rowsAdded} avgConf=${Math.round(result.avgConfidence * 100)}%` : `error="${result.error}"`} dur=${durMs}ms`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error(`[web-upload] file=${body.filename} unexpected error:`, err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  } finally {
    release();
  }
}

// ── HTML page ──────────────────────────────────────────────────────────────

const BULK_UPLOAD_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>${env.TENANT_SHORT} Bulk Upload</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  :root {
    --ink: #0a2540;
    --muted: #6b7280;
    --line: #e5e7eb;
    --bg: #f6f9fc;
    --card: #ffffff;
    --accent: #635bff;
    --ok: #10b981;
    --warn: #f59e0b;
    --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 24px; -webkit-font-smoothing: antialiased; }
  .container { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 8px 14px; background: white; border: 1px solid var(--line); color: var(--ink); text-decoration: none; border-radius: 8px; font-size: 13px; font-weight: 500; transition: background .15s; }
  .btn:hover { background: #fafbfc; }
  .btn.active { background: var(--ink); color: white; border-color: var(--ink); }
  .btn.primary { background: var(--accent); color: white; border-color: var(--accent); cursor: pointer; }
  .btn.primary:hover { background: #524dcc; }
  .btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-bottom: 16px; }

  .drop-zone { border: 2px dashed var(--line); border-radius: 12px; padding: 48px 24px; text-align: center; cursor: pointer; transition: border-color .15s, background .15s; }
  .drop-zone:hover { border-color: var(--accent); background: #fafbfc; }
  .drop-zone.dragging { border-color: var(--accent); background: #f5f4ff; }
  .drop-zone p { margin: 8px 0; color: var(--muted); }
  .drop-zone strong { color: var(--ink); }
  .drop-zone .hint { font-size: 12px; }

  input[type=file] { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); border: 0; }

  .controls { display: flex; gap: 12px; align-items: center; margin-top: 16px; }
  .summary { color: var(--muted); font-size: 13px; }

  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13px; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; background: #fafbfc; }
  tr:last-child td { border-bottom: none; }

  .status { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; }
  .status.queued { background: #eef1f6; color: #4b5563; }
  .status.uploading { background: #fef3c7; color: #92400e; }
  .status.processing { background: #dbeafe; color: #1e40af; }
  .status.done { background: #d1fae5; color: #065f46; }
  .status.duplicate { background: #fef3c7; color: #92400e; }
  .status.error { background: #fee2e2; color: #991b1b; }

  .filename { font-weight: 500; color: var(--ink); }
  .filesize { color: var(--muted); font-size: 12px; }
  .details { color: var(--muted); font-size: 12px; }
  .conf { font-weight: 500; }
  .conf.hi { color: var(--ok); }
  .conf.mid { color: var(--warn); }
  .conf.lo { color: var(--err); }
  .warn-list { margin: 4px 0 0; padding-left: 16px; color: var(--warn); font-size: 12px; }

  .progress-summary { display: flex; gap: 20px; padding: 16px 20px; background: #fafbfc; border-radius: 8px; margin-top: 12px; font-size: 13px; }
  .progress-summary .num { font-size: 20px; font-weight: 600; display: block; }
  .progress-summary .lbl { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
</style>
</head><body><div class="container">
<h1>Bulk Slip Upload</h1>
<div class="meta">Drop a stack of invoice or whiteboard photos here to log them without going through Slack.</div>
<div class="tabs">
  <a class="btn" href="/review?tab=queue">← Inbound Queue</a>
  <a class="btn active" href="/review/upload">Bulk Upload</a>
  <a class="btn" href="/dashboard?view=daily&range=1w">Dashboard</a>
</div>

<div class="card">
  <div class="drop-zone" id="drop" role="button" tabindex="0">
    <p><strong>Click to select files</strong> or drag &amp; drop</p>
    <p class="hint">Images or PDFs · up to 25 MB each · uploads process 3 at a time</p>
  </div>
  <input type="file" id="files" multiple accept="image/*,application/pdf">
  <div class="controls">
    <button class="btn primary" id="submit" disabled>Upload &amp; extract</button>
    <span class="summary" id="summary"></span>
  </div>
</div>

<div class="card" id="results-card" style="display:none;">
  <div class="progress-summary" id="progress-summary" style="display:none;"></div>
  <table id="results-table">
    <thead>
      <tr><th>File</th><th>Status</th><th>Details</th></tr>
    </thead>
    <tbody id="results-body"></tbody>
  </table>
</div>

<script>
const filesInput = document.getElementById('files');
const dropZone = document.getElementById('drop');
const submitBtn = document.getElementById('submit');
const summary = document.getElementById('summary');
const resultsCard = document.getElementById('results-card');
const resultsBody = document.getElementById('results-body');
const progressSummary = document.getElementById('progress-summary');

let selected = [];

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB';
  return (n/(1024*1024)).toFixed(1) + ' MB';
}

function updateSummary() {
  if (!selected.length) {
    summary.textContent = 'No files selected.';
    submitBtn.disabled = true;
    return;
  }
  const total = selected.reduce((s, f) => s + f.size, 0);
  summary.textContent = selected.length + ' file' + (selected.length === 1 ? '' : 's') + ' · ' + fmtSize(total);
  submitBtn.disabled = false;
}

function setSelected(files) {
  selected = Array.from(files).filter(f => f.size <= 25 * 1024 * 1024);
  const dropped = Array.from(files).length - selected.length;
  updateSummary();
  if (dropped > 0) {
    summary.textContent += ' (' + dropped + ' skipped — over 25 MB)';
  }
}

filesInput.addEventListener('change', (e) => setSelected(e.target.files));
dropZone.addEventListener('click', () => filesInput.click());
dropZone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); filesInput.click(); }
});
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  setSelected(e.dataTransfer.files);
});

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result;
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function confClass(pct) {
  if (pct >= 90) return 'hi';
  if (pct >= 75) return 'mid';
  return 'lo';
}

function renderRow(state) {
  const tr = document.createElement('tr');
  tr.id = 'row-' + state.idx;
  tr.innerHTML =
    '<td><div class="filename">' + escapeHtml(state.file.name) + '</div>' +
    '<div class="filesize">' + fmtSize(state.file.size) + '</div></td>' +
    '<td><span class="status ' + state.status + '">' + state.statusLabel + '</span></td>' +
    '<td class="details" id="details-' + state.idx + '">—</td>';
  return tr;
}

function updateRow(state) {
  const row = document.getElementById('row-' + state.idx);
  if (!row) return;
  row.querySelector('.status').className = 'status ' + state.status;
  row.querySelector('.status').textContent = state.statusLabel;
  const detailsCell = document.getElementById('details-' + state.idx);
  if (detailsCell) detailsCell.innerHTML = state.details || '—';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function renderProgressSummary(states) {
  const counts = { queued: 0, uploading: 0, processing: 0, done: 0, duplicate: 0, error: 0 };
  let totalRows = 0;
  for (const s of states) {
    counts[s.status] = (counts[s.status] || 0) + 1;
    if (s.result && s.result.ok) totalRows += (s.result.rowsAdded || 0);
  }
  progressSummary.innerHTML =
    '<div><span class="num">' + counts.done + '</span><span class="lbl">Done</span></div>' +
    '<div><span class="num">' + (counts.processing + counts.uploading) + '</span><span class="lbl">In flight</span></div>' +
    '<div><span class="num">' + counts.queued + '</span><span class="lbl">Queued</span></div>' +
    '<div><span class="num">' + counts.duplicate + '</span><span class="lbl">Duplicate</span></div>' +
    '<div><span class="num">' + counts.error + '</span><span class="lbl">Errors</span></div>' +
    '<div><span class="num">' + totalRows + '</span><span class="lbl">Rows written</span></div>';
  progressSummary.style.display = 'flex';
}

async function uploadOne(state, states) {
  state.status = 'uploading';
  state.statusLabel = 'Uploading';
  updateRow(state);
  renderProgressSummary(states);

  let contentBase64;
  try {
    contentBase64 = await toBase64(state.file);
  } catch (err) {
    state.status = 'error';
    state.statusLabel = 'Error';
    state.details = 'Failed to read file: ' + escapeHtml(err.message || String(err));
    updateRow(state);
    renderProgressSummary(states);
    return;
  }

  state.status = 'processing';
  state.statusLabel = 'Extracting';
  updateRow(state);
  renderProgressSummary(states);

  try {
    const res = await fetch('/api/review/upload/one', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: state.file.name,
        mimeType: state.file.type || 'application/octet-stream',
        contentBase64
      })
    });
    const body = await res.json();
    state.result = body;

    if (!body.ok) {
      state.status = 'error';
      state.statusLabel = 'Error';
      state.details = escapeHtml(body.error || 'Unknown error');
    } else if (body.duplicateReason === 'session') {
      state.status = 'duplicate';
      state.statusLabel = 'Duplicate';
      state.details = 'Identical file already uploaded this session — not written again.';
    } else if (body.duplicateReason === 'sheet') {
      state.status = 'duplicate';
      state.statusLabel = 'Duplicate';
      const label = body.supplier
        ? body.supplier + (body.invoiceNumber ? ' · #' + body.invoiceNumber : '')
        : 'this slip';
      state.details = 'Already in Inbound Delivery Log as ' + escapeHtml(label) + ' — nothing new written.';
    } else {
      state.status = 'done';
      state.statusLabel = 'Done';
      const pct = Math.round(body.avgConfidence * 100);
      const supplier = body.supplier ? body.supplier + (body.invoiceNumber ? ' · #' + body.invoiceNumber : '') : (body.kind === 'whiteboard' ? 'whiteboard' : 'unknown');
      const warnHtml = (body.warnings && body.warnings.length)
        ? '<ul class="warn-list">' + body.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>'
        : '';
      state.details =
        escapeHtml(supplier) + ' · ' +
        body.lineItems + ' line item' + (body.lineItems === 1 ? '' : 's') + ' · ' +
        body.rowsAdded + ' row' + (body.rowsAdded === 1 ? '' : 's') + ' logged · ' +
        '<span class="conf ' + confClass(pct) + '">' + pct + '% conf</span>' +
        warnHtml;
    }
  } catch (err) {
    state.status = 'error';
    state.statusLabel = 'Error';
    state.details = escapeHtml(err.message || String(err));
  }
  updateRow(state);
  renderProgressSummary(states);
}

submitBtn.addEventListener('click', async () => {
  if (!selected.length) return;
  submitBtn.disabled = true;
  filesInput.disabled = true;

  const states = selected.map((file, idx) => ({
    idx, file, status: 'queued', statusLabel: 'Queued', details: '', result: null
  }));
  resultsBody.innerHTML = '';
  for (const st of states) resultsBody.appendChild(renderRow(st));
  resultsCard.style.display = 'block';
  renderProgressSummary(states);

  // Fire all requests concurrently; the server-side semaphore paces them.
  await Promise.all(states.map((st) => uploadOne(st, states)));

  submitBtn.disabled = false;
  filesInput.disabled = false;
  filesInput.value = '';
  selected = [];
  updateSummary();
  summary.textContent = 'Batch complete. Slip Review has any rows that need attention.';
});
</script>
</div></body></html>`;
