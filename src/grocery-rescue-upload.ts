// Bulk upload for the RVFB "Grocery Rescue Data" workbook.
//
// RVFB maintains a monthly Excel workbook where each tab (January…December)
// is one row per pickup with per-category pound totals. This module lets a
// reviewer drop that workbook (or a single-tab CSV export) into the browser
// instead of photographing each Food Lifeline slip and running it through
// the vision extractor.
//
// Each parsed row becomes one synthetic ExtractionResult that flows through
// the same appendExtractionRows / appendSummaryRow pipeline the image path
// uses. normalizeRescueSlip synthesizes invoice_or_order_number as
// `<canonical>-<delivery_date>`, and appendExtractionRows dedupes on
// (supplier, invoice_or_order_number) + photo_url — so re-uploading the
// same month is a no-op.
//
// Photo URL is synthesized as `xlsx-upload://grocery-rescue/<canonical>-<date>`
// so slip-grouping in the Review UI works exactly the same as image slips.

import type { IncomingMessage, ServerResponse } from "node:http";
import * as XLSX from "xlsx";
import { env } from "./config.js";
import { RESCUE_CATEGORIES, normalizeRescueDonor } from "./extraction.js";
import {
  appendExtractionRows,
  appendSummaryRow,
  ensureSheetHeader,
  ensureSummarySheetHeader,
  ensureCorrectionsLogHeader,
  readDeliveryRows
} from "./sheets.js";
import type { ExtractionResult } from "./types.js";

const MAX_BODY_BYTES = 25 * 1024 * 1024;

// Workbook column headers (normalized: lowercase, letters only) → the label
// the row will use inside RESCUE_CATEGORIES. Includes both "protien" (RVFB's
// spelling in the template) and "protein".
const CATEGORY_COLUMN_MAP: Array<{ headerKey: string; rescueLabel: string }> = [
  { headerKey: "nonfooditems",        rescueLabel: "Nonfood" },
  { headerKey: "nonfood",             rescueLabel: "Nonfood" },
  { headerKey: "coffeekiosk",         rescueLabel: "Coffee Kiosk" },
  { headerKey: "bakery",              rescueLabel: "Bakery" },
  { headerKey: "dairyjuicealtdairy",  rescueLabel: "Dairy/Juice/Alt. Dairy" },
  { headerKey: "dairy",               rescueLabel: "Dairy/Juice/Alt. Dairy" },
  { headerKey: "meats",               rescueLabel: "Meat" },
  { headerKey: "meat",                rescueLabel: "Meat" },
  { headerKey: "canneddrygoods",      rescueLabel: "Canned/Dry Goods" },
  { headerKey: "canned",              rescueLabel: "Canned/Dry Goods" },
  { headerKey: "produce",             rescueLabel: "Produce" },
  { headerKey: "preparedperishable",  rescueLabel: "Prepared/Perishable" },
  { headerKey: "prepared",            rescueLabel: "Prepared/Perishable" },
  { headerKey: "frozenfoods",         rescueLabel: "Frozen Foods" },
  { headerKey: "frozen",              rescueLabel: "Frozen Foods" },
  { headerKey: "nonmeatprotien",      rescueLabel: "Non-Meat Protein (eggs, tofu)" },
  { headerKey: "nonmeatprotein",      rescueLabel: "Non-Meat Protein (eggs, tofu)" }
];

// Tab names on the workbook that we should NOT try to parse as monthly rows.
const SKIP_TAB_KEYS = new Set([
  "monthlytemplate", "numbersbystore", "datadump", "summary", "yearly", "notes"
]);

const MONTH_TAB_KEYS = new Set([
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
]);

function normKey(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function isNumberish(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// The workbook stores dates as JS Date at UTC midnight (i.e. 08:00 UTC in PT).
// Convert to a YYYY-MM-DD in America/Los_Angeles so it matches the sheet's
// convention for delivery_date.
function toIsoDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(v);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
    return null;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    // ISO first
    const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
    // M/D/YYYY or M/D/YY
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (us) {
      let year = us[3];
      if (year.length === 2) year = (Number(year) >= 70 ? "19" : "20") + year;
      return `${year}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
    }
    return null;
  }
  if (typeof v === "number") {
    // Excel serial date — SheetJS should already have decoded this when cellDates:true.
    // Handle the raw-number fallback anyway.
    const epoch = Date.UTC(1899, 11, 30); // Excel's day 0
    const ms = epoch + v * 86_400_000;
    return toIsoDate(new Date(ms));
  }
  return null;
}

// ── Row shape passed between preview + commit ─────────────────────────────

export interface ParsedRescueRow {
  monthTab: string;
  sourceRowNumber: number;             // 1-indexed row within the tab
  donorRaw: string;
  donorCanonical: string | null;       // null if we couldn't map it
  storeNumber: string | null;
  date: string | null;                 // YYYY-MM-DD
  categoryTotals: Record<string, number>;
  workbookTotal: number | null;        // "Total Pounds" column, for cross-check
  computedTotal: number;               // sum of categoryTotals
  warnings: string[];
  alreadyLogged: boolean;              // matches an existing row in Inbound Delivery Log
}

export interface ParsedRescueMonth {
  tab: string;
  rowCount: number;
  rows: ParsedRescueRow[];
}

// ── Parser ────────────────────────────────────────────────────────────────

function parseSheet(tabName: string, ws: XLSX.WorkSheet): ParsedRescueRow[] {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null, raw: true });
  if (raw.length === 0) return [];

  // Locate the header row (first row where "Donor Name" appears).
  let headerRow = -1;
  for (let i = 0; i < Math.min(raw.length, 5); i++) {
    if ((raw[i] as unknown[]).some((c) => normKey(c) === "donorname")) {
      headerRow = i;
      break;
    }
  }
  if (headerRow === -1) return [];

  const headers = (raw[headerRow] as unknown[]).map(normKey);
  const idxDonor = headers.indexOf("donorname");
  const idxStore = headers.indexOf("storenumber");
  const idxDate = headers.indexOf("date");
  const idxTotal = headers.indexOf("totalpounds");

  // Build column index → rescueLabel map.
  const categoryIndexes: Array<{ index: number; rescueLabel: string }> = [];
  for (let col = 0; col < headers.length; col++) {
    const hk = headers[col];
    const hit = CATEGORY_COLUMN_MAP.find((c) => c.headerKey === hk);
    if (hit && !categoryIndexes.some((e) => e.rescueLabel === hit.rescueLabel)) {
      categoryIndexes.push({ index: col, rescueLabel: hit.rescueLabel });
    }
  }

  if (idxDonor < 0 || idxDate < 0 || categoryIndexes.length === 0) return [];

  const out: ParsedRescueRow[] = [];
  for (let r = headerRow + 1; r < raw.length; r++) {
    const row = raw[r] as unknown[];
    const donorRaw = String(row[idxDonor] ?? "").trim();

    // Skip re-header rows, "Week X Total" rows, and completely blank rows.
    if (!donorRaw) continue;
    const donorKey = normKey(donorRaw);
    if (donorKey === "donorname") continue;
    if (donorKey.includes("total")) continue;

    const date = toIsoDate(row[idxDate]);
    const storeNumber = row[idxStore] != null ? String(row[idxStore]).trim() : null;

    const warnings: string[] = [];
    const categoryTotals: Record<string, number> = {};
    let computedTotal = 0;
    for (const c of categoryIndexes) {
      const raw = row[c.index];
      if (raw == null || raw === "") continue;
      const n = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n) || n === 0) continue;
      categoryTotals[c.rescueLabel] = (categoryTotals[c.rescueLabel] ?? 0) + n;
      computedTotal += n;
    }
    if (computedTotal === 0) continue; // nothing to log

    const canonical = normalizeRescueDonor(donorRaw);
    if (!canonical) {
      warnings.push(`donor "${donorRaw}" doesn't match a known Food Lifeline donor — row will be skipped on commit`);
    }
    if (!date) {
      warnings.push(`date column is empty or unparseable — row will be skipped on commit`);
    }

    const workbookTotal = idxTotal >= 0 && isNumberish(row[idxTotal]) ? (row[idxTotal] as number) : null;
    if (workbookTotal != null && Math.abs(workbookTotal - computedTotal) > 0.5) {
      warnings.push(
        `workbook "Total Pounds" (${workbookTotal}) doesn't match sum of category cells (${computedTotal})`
      );
    }

    out.push({
      monthTab: tabName,
      sourceRowNumber: r + 1,
      donorRaw,
      donorCanonical: canonical,
      storeNumber,
      date,
      categoryTotals,
      workbookTotal,
      computedTotal,
      warnings,
      alreadyLogged: false
    });
  }
  return out;
}

export function parseWorkbookBuffer(buffer: Buffer, filename: string): ParsedRescueMonth[] {
  // CSV path: one flat sheet, tab name derived from filename.
  const isCsv = /\.csv$/i.test(filename);
  const workbook = isCsv
    ? XLSX.read(buffer.toString("utf8"), { type: "string", cellDates: true, raw: true })
    : XLSX.read(buffer, { type: "buffer", cellDates: true, raw: true });

  const months: ParsedRescueMonth[] = [];
  for (const tab of workbook.SheetNames) {
    const key = normKey(tab);
    if (SKIP_TAB_KEYS.has(key)) continue;
    // If the workbook has explicit monthly tabs, only parse those; otherwise
    // parse every remaining tab (covers single-sheet CSV exports).
    const hasMonthTabs = workbook.SheetNames.some((n) => MONTH_TAB_KEYS.has(normKey(n)));
    if (hasMonthTabs && !MONTH_TAB_KEYS.has(key)) continue;

    const ws = workbook.Sheets[tab];
    const rows = parseSheet(tab, ws);
    if (rows.length > 0) {
      months.push({ tab, rowCount: rows.length, rows });
    }
  }
  return months;
}

// ── Build a synthetic ExtractionResult ────────────────────────────────────

function buildRescueExtraction(row: ParsedRescueRow): ExtractionResult {
  if (!row.donorCanonical || !row.date) {
    throw new Error("row missing donor or date — should have been filtered before commit");
  }
  const lineItems = Object.entries(row.categoryTotals).map(([label, lb]) => {
    const cat = RESCUE_CATEGORIES.find((c) => c.label === label)!;
    return {
      item_code_raw: null,
      item_name_raw: cat.label,
      item_name_normalized: cat.normalized,
      quantity_ordered: null,
      quantity: lb,
      quantity_raw: String(lb),
      unit: "lb" as const,
      pack_size_raw: null,
      approx_weight: lb,
      category: cat.category,
      unit_cost: null,
      line_total: null,
      is_fee: false,
      notes: "from RVFB Grocery Rescue workbook",
      confidence: 1
    };
  });

  return {
    document_type: "invoice",
    supplier: "grocery_rescue",
    invoice_date: row.date,
    delivery_date: row.date,
    // normalizeRescueSlip will synthesize this from donor+date. Set it here
    // too so appendExtractionRows's dedupe check sees it up front.
    invoice_or_order_number: `${row.donorCanonical}-${row.date}`,
    destination_org: env.TENANT_NAME,
    donor_org: row.donorCanonical,
    is_donation: true,
    line_items: lineItems,
    fees: [],
    totals: { subtotal: null, tax: null, grand_total: null },
    source_warnings: row.warnings.slice()
  };
}

function photoUrlFor(row: ParsedRescueRow): string {
  return `xlsx-upload://grocery-rescue/${row.donorCanonical}-${row.date}`;
}

// ── Existing-slip lookup (used to flag "alreadyLogged" in the preview) ────

async function loadExistingRescueKeys(): Promise<Set<string>> {
  const rows = await readDeliveryRows({ supplier: "grocery_rescue", limit: 100000 });
  const keys = new Set<string>();
  for (const r of rows) {
    if (!r.donor_org || !r.delivery_date) continue;
    keys.add(`${r.donor_org}::${r.delivery_date}`);
  }
  return keys;
}

// ── HTTP handlers ─────────────────────────────────────────────────────────

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

interface PreviewBody {
  filename: string;
  contentBase64: string;
}

interface PreviewResponseRow extends ParsedRescueRow {
  commitId: string;   // stable identifier so the commit call can reference it
}

interface PreviewResponse {
  ok: true;
  months: Array<{
    tab: string;
    rowCount: number;
    rows: PreviewResponseRow[];
  }>;
  knownDonors: string[];
  categoryLabels: string[];
}

export async function handleGroceryRescueUploadPreviewRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: PreviewBody;
  try {
    body = await readJsonBody<PreviewBody>(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }

  if (!body.filename || !body.contentBase64) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "filename and contentBase64 are required" }));
    return;
  }

  try {
    const buffer = Buffer.from(body.contentBase64, "base64");
    const months = parseWorkbookBuffer(buffer, body.filename);
    const existing = await loadExistingRescueKeys();

    const response: PreviewResponse = {
      ok: true,
      months: months.map((m) => ({
        tab: m.tab,
        rowCount: m.rowCount,
        rows: m.rows.map((r, idx) => {
          const alreadyLogged =
            r.donorCanonical != null && r.date != null &&
            existing.has(`${r.donorCanonical}::${r.date}`);
          return {
            ...r,
            alreadyLogged,
            commitId: `${m.tab}::${idx}`
          };
        })
      })),
      knownDonors: ["QFC-MI", "QFC-BWY", "SWY-RB", "SWY-GEN", "HG"],
      categoryLabels: RESCUE_CATEGORIES.map((c) => c.label)
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (err) {
    console.error("[grocery-rescue-upload] preview error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
  }
}

interface CommitBody {
  rows: ParsedRescueRow[];
}

interface CommitRowResult {
  commitId: string;
  donorCanonical: string | null;
  date: string | null;
  ok: boolean;
  status: "written" | "duplicate" | "skipped" | "error";
  rowsAdded: number;
  message?: string;
}

export async function handleGroceryRescueUploadCommitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  uploadedBy: string
): Promise<void> {
  let body: CommitBody;
  try {
    body = await readJsonBody<CommitBody>(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }

  if (!Array.isArray(body.rows) || body.rows.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "rows must be a non-empty array" }));
    return;
  }

  await ensureSheetHeader();
  await ensureSummarySheetHeader();
  await ensureCorrectionsLogHeader();

  const results: CommitRowResult[] = [];
  const slackMessageTsBase = Date.now();

  // Sequential — the write to Inbound Delivery Log is a Sheets append and
  // parallelizing risks racing dedupe checks against each other for
  // same-day rows.
  for (let i = 0; i < body.rows.length; i++) {
    const row = body.rows[i];
    const commitId = `${row.monthTab}::${row.sourceRowNumber}`;
    if (!row.donorCanonical || !row.date || row.computedTotal <= 0) {
      results.push({
        commitId, donorCanonical: row.donorCanonical, date: row.date,
        ok: true, status: "skipped", rowsAdded: 0,
        message: !row.donorCanonical ? "unknown donor" : !row.date ? "missing date" : "no weight"
      });
      continue;
    }

    try {
      const extraction = buildRescueExtraction(row);
      const photoUrl = photoUrlFor(row);
      const slackMessageTs = `${slackMessageTsBase}-${i}`;

      const rowsAdded = await appendExtractionRows({
        extraction,
        photoUrl,
        slackChannel: "grocery-rescue-upload",
        slackMessageTs,
        uploadedBy
      });
      if (rowsAdded > 0) {
        await appendSummaryRow({ extraction, photoUrl });
        results.push({
          commitId, donorCanonical: row.donorCanonical, date: row.date,
          ok: true, status: "written", rowsAdded,
          message: `${Object.keys(row.categoryTotals).length} categor${Object.keys(row.categoryTotals).length === 1 ? "y" : "ies"} · ${row.computedTotal} lb`
        });
      } else {
        results.push({
          commitId, donorCanonical: row.donorCanonical, date: row.date,
          ok: true, status: "duplicate", rowsAdded: 0,
          message: "already in Inbound Delivery Log"
        });
      }
    } catch (err) {
      console.error(`[grocery-rescue-upload] commit failed for ${commitId}:`, err);
      results.push({
        commitId, donorCanonical: row.donorCanonical, date: row.date,
        ok: false, status: "error", rowsAdded: 0,
        message: (err as Error).message
      });
    }
  }

  const written = results.filter((r) => r.status === "written").length;
  const duplicate = results.filter((r) => r.status === "duplicate").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const errored = results.filter((r) => r.status === "error").length;
  console.log(
    `[grocery-rescue-upload] commit by=${uploadedBy} total=${results.length} written=${written} duplicate=${duplicate} skipped=${skipped} errored=${errored}`
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, results, written, duplicate, skipped, errored }));
}

export async function handleGroceryRescueUploadPageRequest(res: ServerResponse): Promise<void> {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(GROCERY_RESCUE_UPLOAD_HTML);
}

// ── HTML page ─────────────────────────────────────────────────────────────

const GROCERY_RESCUE_UPLOAD_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>${env.TENANT_SHORT} Grocery Rescue Upload</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  :root {
    --ink: #0a2540; --muted: #6b7280; --line: #e5e7eb; --bg: #f6f9fc;
    --card: #ffffff; --accent: #635bff; --ok: #10b981; --warn: #f59e0b; --err: #ef4444;
  }
  * { box-sizing: border-box; }
  body { font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--ink); margin: 0; padding: 24px; -webkit-font-smoothing: antialiased; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; }
  .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
  .btn { display: inline-block; padding: 8px 14px; background: white; border: 1px solid var(--line); color: var(--ink); text-decoration: none; border-radius: 8px; font-size: 13px; font-weight: 500; cursor: pointer; }
  .btn:hover { background: #fafbfc; }
  .btn.active { background: var(--ink); color: white; border-color: var(--ink); }
  .btn.primary { background: var(--accent); color: white; border-color: var(--accent); }
  .btn.primary:hover { background: #524dcc; }
  .btn.primary:disabled { opacity: .5; cursor: not-allowed; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; margin-bottom: 16px; }
  .drop-zone { border: 2px dashed var(--line); border-radius: 12px; padding: 40px 24px; text-align: center; cursor: pointer; }
  .drop-zone:hover { border-color: var(--accent); background: #fafbfc; }
  .drop-zone.dragging { border-color: var(--accent); background: #f5f4ff; }
  .drop-zone p { margin: 8px 0; color: var(--muted); }
  .drop-zone strong { color: var(--ink); }
  input[type=file] { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); border:0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 500; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; background: #fafbfc; position: sticky; top: 0; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.skip { background: #fef3c7; }
  tr.dup { background: #f3f4f6; color: var(--muted); }
  tr.ok:hover { background: #fafbfc; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; }
  .badge.new { background: #d1fae5; color: #065f46; }
  .badge.dup { background: #e5e7eb; color: #4b5563; }
  .badge.skip { background: #fef3c7; color: #92400e; }
  .badge.err { background: #fee2e2; color: #991b1b; }
  .warnings { color: var(--warn); font-size: 11px; margin-top: 4px; }
  .month-section { margin-bottom: 20px; }
  .month-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; padding: 0 4px; }
  .month-header .count { color: var(--muted); font-size: 13px; }
  .table-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .progress-summary { display: flex; gap: 20px; padding: 16px 20px; background: #fafbfc; border-radius: 8px; margin-bottom: 12px; font-size: 13px; }
  .progress-summary .num { font-size: 20px; font-weight: 600; display: block; }
  .progress-summary .lbl { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .03em; }
  input[type=checkbox] { transform: scale(1.1); cursor: pointer; }
  .controls { display: flex; gap: 12px; align-items: center; margin-top: 12px; }
  .summary { color: var(--muted); font-size: 13px; }
  code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
</style>
</head><body><div class="container">
<h1>Grocery Rescue Upload</h1>
<div class="meta">Skip the per-slip photo pipeline: drop the RVFB "Grocery Rescue Data" workbook (or a single-month CSV) and each pickup row becomes one slip in the Inbound Delivery Log.</div>
<div class="tabs">
  <a class="btn" href="/review?tab=queue">← Inbound Queue</a>
  <a class="btn" href="/review/upload">Bulk Upload (photos)</a>
  <a class="btn active" href="/review/upload/grocery-rescue">Grocery Rescue Upload</a>
  <a class="btn" href="/dashboard?view=daily&range=1w">Dashboard</a>
</div>

<div class="card" id="upload-card">
  <div class="drop-zone" id="drop" role="button" tabindex="0">
    <p><strong>Tap or click to pick a workbook</strong></p>
    <p>Accepts .xlsx (full RVFB Grocery Rescue Data workbook) or .csv (single monthly tab exported from Excel or Google Sheets)</p>
  </div>
  <input type="file" id="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv">
  <div class="controls">
    <button class="btn primary" id="parse-btn" disabled>Preview rows</button>
    <span class="summary" id="file-summary"></span>
  </div>
</div>

<div id="preview" style="display:none;"></div>

<script>
const fileInput = document.getElementById('file');
const drop = document.getElementById('drop');
const parseBtn = document.getElementById('parse-btn');
const fileSummary = document.getElementById('file-summary');
const preview = document.getElementById('preview');
let selectedFile = null;
let parsed = null;

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtSize(n) { if (n < 1024) return n + ' B'; if (n < 1024*1024) return (n/1024).toFixed(1) + ' KB'; return (n/(1024*1024)).toFixed(1) + ' MB'; }
function toBase64(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => { const s = r.result; const c = s.indexOf(','); resolve(c >= 0 ? s.slice(c+1) : s); }; r.onerror = () => reject(r.error); r.readAsDataURL(file); }); }

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragging'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) { fileInput.files = e.dataTransfer.files; setFile(f); } });
fileInput.addEventListener('change', (e) => { setFile(e.target.files[0]); });

function setFile(f) {
  if (!f) { selectedFile = null; parseBtn.disabled = true; fileSummary.textContent = ''; return; }
  selectedFile = f;
  parseBtn.disabled = false;
  fileSummary.textContent = f.name + ' · ' + fmtSize(f.size);
}

parseBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  parseBtn.disabled = true;
  fileSummary.textContent = 'Parsing…';
  try {
    const contentBase64 = await toBase64(selectedFile);
    const res = await fetch('/api/review/upload/grocery-rescue/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: selectedFile.name, contentBase64 })
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'preview failed');
    parsed = body;
    renderPreview(body);
    fileSummary.textContent = selectedFile.name + ' · parsed ' + body.months.reduce((s,m) => s + m.rowCount, 0) + ' row(s) across ' + body.months.length + ' month(s)';
  } catch (err) {
    fileSummary.textContent = 'Error: ' + (err.message || String(err));
    console.error(err);
  } finally {
    parseBtn.disabled = false;
  }
});

function renderPreview(body) {
  const categoryLabels = body.categoryLabels;
  const parts = [];
  let totalNew = 0, totalDup = 0, totalSkip = 0, totalLb = 0;
  for (const m of body.months) {
    let mNew = 0, mDup = 0, mSkip = 0, mLb = 0;
    const rows = [];
    for (const r of m.rows) {
      const invalid = !r.donorCanonical || !r.date;
      const state = invalid ? 'skip' : (r.alreadyLogged ? 'dup' : 'ok');
      if (state === 'ok') { mNew++; mLb += r.computedTotal; }
      else if (state === 'dup') mDup++;
      else mSkip++;

      const badge = state === 'ok'
        ? '<span class="badge new">will write</span>'
        : state === 'dup' ? '<span class="badge dup">already logged</span>'
        : '<span class="badge skip">will skip</span>';

      const checkable = state === 'ok';
      const catCells = categoryLabels.map(lbl => {
        const v = r.categoryTotals[lbl];
        return '<td class="num">' + (v != null && v !== 0 ? v : '') + '</td>';
      }).join('');

      const warnHtml = r.warnings && r.warnings.length
        ? '<div class="warnings">' + r.warnings.map(esc).join(' · ') + '</div>' : '';

      rows.push(
        '<tr class="' + state + '">' +
        '<td><input type="checkbox" data-commit-id="' + esc(r.commitId) + '" ' + (checkable ? 'checked' : 'disabled') + '></td>' +
        '<td>' + esc(r.date || '—') + '</td>' +
        '<td>' + esc(r.donorCanonical || r.donorRaw) +
          (r.donorCanonical && r.donorCanonical !== r.donorRaw ? ' <span style="color:var(--muted);font-size:11px;">(' + esc(r.donorRaw) + ')</span>' : '') +
          warnHtml +
        '</td>' +
        catCells +
        '<td class="num">' + r.computedTotal + '</td>' +
        '<td>' + badge + '</td>' +
        '</tr>'
      );
    }
    totalNew += mNew; totalDup += mDup; totalSkip += mSkip; totalLb += mLb;

    const catHeaders = categoryLabels.map(l => '<th>' + esc(l.replace(/ \\(.*\\)$/, '')) + '</th>').join('');
    parts.push(
      '<div class="month-section">' +
      '<div class="month-header"><h2>' + esc(m.tab) + '</h2>' +
      '<span class="count">' + mNew + ' new · ' + mDup + ' already logged · ' + mSkip + ' skipped · ' + mLb + ' lb pending</span></div>' +
      '<div class="card" style="padding:0;overflow:hidden;"><div class="table-scroll"><table>' +
      '<thead><tr><th style="width:32px;"><input type="checkbox" data-month-toggle="' + esc(m.tab) + '" checked></th>' +
      '<th>Date</th><th>Donor</th>' + catHeaders + '<th>Total lb</th><th>Status</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody></table></div></div></div>'
    );
  }

  preview.innerHTML =
    '<div class="card">' +
    '<div class="progress-summary">' +
    '<div><span class="num">' + totalNew + '</span><span class="lbl">Will write</span></div>' +
    '<div><span class="num">' + totalDup + '</span><span class="lbl">Duplicates (skipped)</span></div>' +
    '<div><span class="num">' + totalSkip + '</span><span class="lbl">Unmapped / no data</span></div>' +
    '<div><span class="num">' + totalLb + '</span><span class="lbl">Total lb pending</span></div>' +
    '</div>' +
    '<div class="controls">' +
    '<button class="btn primary" id="commit-btn">Commit selected rows</button>' +
    '<span class="summary" id="commit-summary"></span>' +
    '</div>' +
    '</div>' +
    parts.join('');
  preview.style.display = 'block';

  // Wire per-month toggle: (un)checks every enabled row in the month.
  preview.querySelectorAll('[data-month-toggle]').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const tab = e.target.getAttribute('data-month-toggle');
      const section = e.target.closest('.month-section');
      section.querySelectorAll('input[type="checkbox"][data-commit-id]:not(:disabled)').forEach((row) => {
        row.checked = e.target.checked;
      });
    });
  });

  document.getElementById('commit-btn').addEventListener('click', commitSelected);
}

async function commitSelected() {
  const selectedIds = new Set();
  preview.querySelectorAll('input[type="checkbox"][data-commit-id]:checked').forEach((cb) => {
    selectedIds.add(cb.getAttribute('data-commit-id'));
  });
  if (!selectedIds.size) { document.getElementById('commit-summary').textContent = 'Nothing selected.'; return; }

  const rows = [];
  for (const m of parsed.months) {
    for (const r of m.rows) {
      if (selectedIds.has(r.commitId)) rows.push(r);
    }
  }

  const btn = document.getElementById('commit-btn');
  const summary = document.getElementById('commit-summary');
  btn.disabled = true;
  summary.textContent = 'Writing ' + rows.length + ' row(s) to sheet…';

  try {
    const res = await fetch('/api/review/upload/grocery-rescue/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows })
    });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || 'commit failed');
    summary.innerHTML =
      '<strong>Done.</strong> ' + body.written + ' written · ' + body.duplicate + ' duplicate · ' + body.skipped + ' skipped · ' + body.errored + ' error(s).';

    const resultsById = new Map();
    for (const r of body.results) resultsById.set(r.commitId, r);
    preview.querySelectorAll('input[type="checkbox"][data-commit-id]').forEach((cb) => {
      const tr = cb.closest('tr');
      const id = cb.getAttribute('data-commit-id');
      const r = resultsById.get(id);
      if (!r) return;
      const cell = tr.querySelector('td:last-child');
      if (r.status === 'written') { cell.innerHTML = '<span class="badge new">written (' + r.rowsAdded + ' rows)</span>'; tr.className = ''; }
      else if (r.status === 'duplicate') { cell.innerHTML = '<span class="badge dup">duplicate</span>'; tr.className = 'dup'; }
      else if (r.status === 'skipped') { cell.innerHTML = '<span class="badge skip">skipped</span>'; }
      else { cell.innerHTML = '<span class="badge err">error: ' + esc(r.message || '') + '</span>'; }
    });
  } catch (err) {
    summary.textContent = 'Error: ' + (err.message || String(err));
  } finally {
    btn.disabled = false;
  }
}
</script>
</div></body></html>`;
