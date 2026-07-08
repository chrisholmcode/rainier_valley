/**
 * One-off backfill: read rows from the Inbound Delivery Log, group by
 * (supplier, invoice_or_order_number), apply the same rollup used by the
 * live ingest, and append one row per shipment to the Inventory Summary tab.
 *
 * Usage:
 *   npm run build && node dist/backfill-summary.js              # today (PT)
 *   npm run build && node dist/backfill-summary.js 2026-06-18   # specific date
 *   npm run build && node dist/backfill-summary.js all          # everything in the log
 *
 * "Today" filters by created_at (when the photo was uploaded), not delivery_date.
 */
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { ensureSummarySheetHeader, appendSummaryRow, SHEET_HEADERS } from "./sheets.js";
import type { ExtractionResult, LineItem, FeeItem, Supplier, DocumentType } from "./types.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

function todayPT(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function isoToPTDate(iso: string): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(ts));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

const VALID_SUPPLIERS: Supplier[] = ["carusos", "charlies", "nw_harvest", "pacific", "weigelt", "unknown"];
function normalizeSupplier(v: unknown): Supplier {
  const s = String(v ?? "").trim().toLowerCase();
  return (VALID_SUPPLIERS as string[]).includes(s) ? (s as Supplier) : "unknown";
}

const VALID_DOC_TYPES: DocumentType[] = ["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"];
function normalizeDocType(v: unknown): DocumentType {
  const s = String(v ?? "").trim().toLowerCase();
  return (VALID_DOC_TYPES as string[]).includes(s) ? (s as DocumentType) : "unknown";
}

const VALID_CATEGORIES = new Set([
  "produce",
  "meat_protein",
  "dairy",
  "shelf_stable",
  "frozen",
  "non_food",
  "unknown"
]);
function normalizeCategory(v: unknown): LineItem["category"] {
  const s = String(v ?? "").trim().toLowerCase();
  return VALID_CATEGORIES.has(s) ? (s as LineItem["category"]) : "unknown";
}

const VALID_UNITS = new Set(["case", "ct", "lb", "oz", "ea", "bushel", "other"]);
function normalizeUnit(v: unknown): LineItem["unit"] {
  const s = String(v ?? "").trim().toLowerCase();
  return VALID_UNITS.has(s) ? (s as LineItem["unit"]) : null;
}

interface RawSheetRow {
  created_at: string;
  supplier: string;
  document_type: string;
  invoice_date: string;
  delivery_date: string;
  invoice_or_order_number: string;
  destination_org: string;
  item_code_raw: string;
  item_name_raw: string;
  item_name_normalized: string;
  quantity_ordered: string;
  quantity: string;
  quantity_raw: string;
  unit: string;
  pack_size_raw: string;
  approx_weight: string;
  category: string;
  unit_cost: string;
  line_total: string;
  confidence: string;
  is_fee: string;
  notes: string;
  photo_url: string;
}

function rowToObject(row: string[]): RawSheetRow {
  const obj: Record<string, string> = {};
  SHEET_HEADERS.forEach((h, i) => {
    obj[h] = row[i] ?? "";
  });
  return obj as unknown as RawSheetRow;
}

async function readAllDeliveryRows(): Promise<RawSheetRow[]> {
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const rows = (res.data.values ?? []).slice(1);
  return rows.map((r) => rowToObject(r as string[]));
}

function rowToLineItem(row: RawSheetRow): LineItem {
  return {
    item_code_raw: row.item_code_raw || null,
    item_name_raw: row.item_name_raw || null,
    item_name_normalized: row.item_name_normalized || null,
    quantity_ordered: toNumber(row.quantity_ordered),
    quantity: toNumber(row.quantity),
    quantity_raw: row.quantity_raw || null,
    unit: normalizeUnit(row.unit),
    pack_size_raw: row.pack_size_raw || null,
    approx_weight: toNumber(row.approx_weight),
    category: normalizeCategory(row.category),
    unit_cost: toNumber(row.unit_cost),
    line_total: toNumber(row.line_total),
    is_fee: toBool(row.is_fee),
    notes: row.notes || null,
    confidence: toNumber(row.confidence) ?? 0
  };
}

function rowToFeeItem(row: RawSheetRow): FeeItem {
  return {
    description: row.item_name_raw || row.notes || "fee",
    amount: toNumber(row.line_total)
  };
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const mode: "all" | "date" = arg === "all" ? "all" : "date";
  const targetDate = arg && arg !== "all" ? arg : todayPT();

  console.log(
    mode === "all"
      ? `Backfilling Inventory Summary for ALL rows in Inbound Delivery Log`
      : `Backfilling Inventory Summary for created_at == ${targetDate} (PT)`
  );

  const allRows = await readAllDeliveryRows();
  const filtered = mode === "all" ? allRows : allRows.filter((r) => isoToPTDate(r.created_at) === targetDate);
  console.log(`Read ${allRows.length} total rows; ${filtered.length} match the filter.`);

  // Group by (supplier, invoice_or_order_number). Skip rows missing both.
  const groups = new Map<string, RawSheetRow[]>();
  let skippedNoInvoice = 0;
  for (const row of filtered) {
    const supplier = normalizeSupplier(row.supplier);
    const invoice = (row.invoice_or_order_number || "").trim();
    if (!invoice) {
      skippedNoInvoice++;
      continue;
    }
    const key = `${supplier}|${invoice}`;
    const arr = groups.get(key) ?? [];
    arr.push(row);
    groups.set(key, arr);
  }
  if (skippedNoInvoice) console.log(`Skipped ${skippedNoInvoice} rows with no invoice number.`);
  console.log(`Found ${groups.size} unique shipments to backfill.`);

  await ensureSummarySheetHeader();

  let written = 0;
  for (const [key, rows] of groups) {
    const supplier = normalizeSupplier(rows[0].supplier);
    const documentType = normalizeDocType(rows[0].document_type);
    const invoiceDate = rows[0].invoice_date || null;
    const deliveryDate = rows[0].delivery_date || null;
    const invoice = rows[0].invoice_or_order_number || null;
    const destinationOrg = rows[0].destination_org || null;
    const photoUrl = rows.find((r) => r.photo_url)?.photo_url || "";

    const lineItems: LineItem[] = [];
    const fees: FeeItem[] = [];
    for (const r of rows) {
      if (toBool(r.is_fee)) {
        fees.push(rowToFeeItem(r));
      } else {
        lineItems.push(rowToLineItem(r));
      }
    }

    // grand_total isn't stored per-row, so let rollupExtraction fall back to summing line_totals + fee amounts.
    const extraction: ExtractionResult = {
      document_type: documentType,
      supplier,
      invoice_date: invoiceDate,
      delivery_date: deliveryDate,
      invoice_or_order_number: invoice,
      destination_org: destinationOrg,
      donor_org: null,
      is_donation: null,
      line_items: lineItems,
      fees,
      totals: { subtotal: null, tax: null, grand_total: null },
      source_warnings: []
    };

    await appendSummaryRow({ extraction, photoUrl });
    written++;
    console.log(`  • ${key} — ${lineItems.length} items, ${fees.length} fees → Summary`);
  }

  console.log(`Done. Wrote ${written} summary rows.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
