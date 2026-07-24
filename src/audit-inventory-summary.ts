/**
 * One-shot read-only audit of the Inventory Summary tab.
 *
 * Confirms three invariants and reports anomalies:
 *   1. Every distinct (supplier, invoice_or_order_number) group in the Inbound
 *      Delivery Log has a corresponding Summary row.
 *   2. Every Summary row still matches Inbound Delivery Log rows on
 *      supplier/invoice (no orphaned summary rows).
 *   3. weight_lb on the summary row matches the sum of pounds derived from
 *      the current delivery rows (same rule as src/dashboard.ts).
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/audit-inventory-summary.ts
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SUMMARY_SHEET_HEADERS } from "./sheets.js";
import type { DeliverySheetRow } from "./types.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function toNumber(v: unknown): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

function isFee(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.toString().toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function isEmptySkeletonRow(r: DeliverySheetRow): boolean {
  if (!r.notes || !r.notes.includes("auto-inserted skeleton")) return false;
  const q = (r.quantity ?? "").trim();
  return q === "" || q === "0" || toNumber(r.quantity) === 0;
}

function rowPounds(r: DeliverySheetRow): number | null {
  const aw = toNumber(r.approx_weight);
  if (aw > 0) return aw;
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    const q = toNumber(r.quantity);
    if (q > 0) return q;
  }
  return null;
}

async function main(): Promise<void> {
  const [deliveryRows, summaryRes] = await Promise.all([
    readDeliveryRows({ limit: 20000 }),
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      range: `${env.SUMMARY_WORKSHEET_NAME}!A:${String.fromCharCode(65 + SUMMARY_SHEET_HEADERS.length - 1)}`
    })
  ]);

  const summaryRows = summaryRes.data.values ?? [];
  const header = summaryRows[0] ?? [];
  const idx = (name: string): number => header.indexOf(name);
  const iSupplier = idx("supplier");
  const iInvoice = idx("invoice_or_order_number");
  const iPhoto = idx("photo_url");
  const iWeight = idx("weight_lb");
  const iFoodType = idx("food_type");
  const iIsFood = idx("is_food");
  const iCost = idx("cost");
  const iDonation = idx("donation");

  console.log(`# Inventory Summary audit\n`);
  console.log(`Summary rows: ${summaryRows.length - 1}`);
  console.log(`Delivery rows: ${deliveryRows.length}`);
  console.log(``);

  // Build delivery groups keyed by (supplier, invoice) AND by photo_url.
  interface Group {
    supplier: string;
    invoice: string;
    photoUrls: Set<string>;
    rows: DeliverySheetRow[];
    weighedRows: number;
    unweighedRows: number;
    poundsSum: number;
  }
  const deliveryGroups = new Map<string, Group>();
  const photoToKey = new Map<string, string>();

  for (const r of deliveryRows) {
    if (isFee(r.is_fee)) continue;
    if (isEmptySkeletonRow(r)) continue;
    const supplier = (r.supplier ?? "").trim();
    const invoice = (r.invoice_or_order_number ?? "").trim();
    if (!supplier || !invoice) continue;
    const key = `${supplier}::${invoice}`;
    let g = deliveryGroups.get(key);
    if (!g) {
      g = { supplier, invoice, photoUrls: new Set(), rows: [], weighedRows: 0, unweighedRows: 0, poundsSum: 0 };
      deliveryGroups.set(key, g);
    }
    g.rows.push(r);
    if (r.photo_url) {
      g.photoUrls.add(r.photo_url);
      photoToKey.set(r.photo_url, key);
    }
    const p = rowPounds(r);
    if (p != null) {
      g.poundsSum += p;
      g.weighedRows += 1;
    } else {
      g.unweighedRows += 1;
    }
  }

  // Index summary rows by (supplier, invoice).
  interface SummaryEntry { rowNum: number; supplier: string; invoice: string; weight: number; photo: string; foodType: string; }
  const summaryByKey = new Map<string, SummaryEntry[]>();
  for (let i = 1; i < summaryRows.length; i++) {
    const row = summaryRows[i];
    const supplier = String(row[iSupplier] ?? "").trim();
    const invoice = String(row[iInvoice] ?? "").trim();
    const entry: SummaryEntry = {
      rowNum: i + 1,
      supplier,
      invoice,
      weight: toNumber(row[iWeight]),
      photo: String(row[iPhoto] ?? "").trim(),
      foodType: String(row[iFoodType] ?? "").trim()
    };
    const key = `${supplier}::${invoice}`;
    if (!summaryByKey.has(key)) summaryByKey.set(key, []);
    summaryByKey.get(key)!.push(entry);
  }

  // Invariant 1: every delivery group has a summary row.
  const missingSummary: Group[] = [];
  for (const [key, g] of deliveryGroups) {
    if (!summaryByKey.has(key)) missingSummary.push(g);
  }

  // Invariant 2: every summary row matches a delivery group.
  const orphanSummary: SummaryEntry[] = [];
  for (const [key, entries] of summaryByKey) {
    if (!deliveryGroups.has(key)) {
      for (const e of entries) orphanSummary.push(e);
    }
  }

  // Invariant 3: weight_lb matches recomputed pounds (within 1 lb rounding).
  interface WeightMismatch { key: string; summary: number; recomputed: number; delta: number; coverage: string; }
  const mismatches: WeightMismatch[] = [];
  const duplicateSummaryKeys: string[] = [];
  for (const [key, entries] of summaryByKey) {
    if (entries.length > 1) duplicateSummaryKeys.push(`${key} (×${entries.length})`);
    const g = deliveryGroups.get(key);
    if (!g) continue;
    for (const e of entries) {
      const recomputed = Number(g.poundsSum.toFixed(2));
      const delta = Math.abs(e.weight - recomputed);
      if (delta > 1) {
        const coverage = `${g.weighedRows}/${g.weighedRows + g.unweighedRows}`;
        mismatches.push({ key, summary: e.weight, recomputed, delta, coverage });
      }
    }
  }

  console.log(`## Invariant checks\n`);
  console.log(`- Missing summary rows (delivery group with no matching summary): **${missingSummary.length}**`);
  console.log(`- Orphan summary rows (summary with no matching delivery group): **${orphanSummary.length}**`);
  console.log(`- Duplicate summary keys (>1 summary row for same supplier+invoice): **${duplicateSummaryKeys.length}**`);
  console.log(`- Weight mismatches (|summary - recomputed| > 1 lb): **${mismatches.length}**`);
  console.log(``);

  if (missingSummary.length > 0) {
    console.log(`### Missing summary rows (up to 15)`);
    for (const g of missingSummary.slice(0, 15)) {
      console.log(`- ${g.supplier} / ${g.invoice} — ${g.rows.length} delivery rows, ${g.poundsSum.toFixed(0)} lbs`);
    }
    console.log(``);
  }

  if (orphanSummary.length > 0) {
    console.log(`### Orphan summary rows (up to 15)`);
    for (const e of orphanSummary.slice(0, 15)) {
      console.log(`- row ${e.rowNum}: ${e.supplier} / ${e.invoice} — weight ${e.weight}`);
    }
    console.log(``);
  }

  if (duplicateSummaryKeys.length > 0) {
    console.log(`### Duplicate summary keys (up to 15)`);
    for (const k of duplicateSummaryKeys.slice(0, 15)) console.log(`- ${k}`);
    console.log(``);
  }

  if (mismatches.length > 0) {
    console.log(`### Weight mismatches (up to 20, sorted by delta desc)`);
    mismatches.sort((a, b) => b.delta - a.delta);
    for (const m of mismatches.slice(0, 20)) {
      console.log(`- ${m.key} — summary=${m.summary} recomputed=${m.recomputed} Δ=${m.delta.toFixed(1)} coverage=${m.coverage}`);
    }
    console.log(``);
  }

  // Bonus: nulls on required fields
  let nullWeight = 0, nullFoodType = 0, nullCost = 0, nullDonation = 0;
  for (let i = 1; i < summaryRows.length; i++) {
    const row = summaryRows[i];
    if (!String(row[iWeight] ?? "").trim()) nullWeight += 1;
    if (!String(row[iFoodType] ?? "").trim()) nullFoodType += 1;
    if (!String(row[iCost] ?? "").trim()) nullCost += 1;
    if (!String(row[iDonation] ?? "").trim()) nullDonation += 1;
    void iIsFood;
  }
  console.log(`## Null counts (out of ${summaryRows.length - 1} summary rows)`);
  console.log(`- weight_lb: ${nullWeight}`);
  console.log(`- food_type: ${nullFoodType}`);
  console.log(`- cost: ${nullCost}`);
  console.log(`- donation: ${nullDonation}`);
}

main().catch((err) => {
  console.error("audit failed:", (err as Error).message);
  process.exit(1);
});
