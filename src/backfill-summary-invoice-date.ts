/**
 * One-off: for every Inventory Summary row that is missing invoice_date,
 * look up the matching Inbound Delivery Log rows by (supplier, invoice_or_order_number)
 * (falling back to photo_url) and copy invoice_date over if the log has it filled in.
 *
 * Idempotent — only fills empty Summary invoice_date cells; never overwrites.
 *
 * Usage:
 *   npx tsx src/backfill-summary-invoice-date.ts [--apply]
 *
 *   Without --apply, prints a dry-run diff. With --apply, writes.
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS, SUMMARY_SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function indexToA1(col0: number): string {
  let n = col0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function normalizeInvoice(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.replace(/^0+/, "") || "0";
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`Backfilling Inventory Summary.invoice_date from Inbound Delivery Log (${apply ? "APPLY" : "dry-run"})`);

  // ── Read Inbound Delivery Log ────────────────────────────────────────────
  const lastLogCol = indexToA1(SHEET_HEADERS.length - 1);
  const logRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastLogCol}`
  });
  const logRows = logRes.data.values ?? [];
  const lIdx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const lSup = lIdx.get("supplier")!;
  const lInv = lIdx.get("invoice_or_order_number")!;
  const lInvoiceDate = lIdx.get("invoice_date")!;
  const lPhoto = lIdx.get("photo_url")!;

  // Build lookup: (supplier, invoice_or_order_number) -> invoice_date, photo_url -> invoice_date
  const byInvoiceKey = new Map<string, string>();
  const byPhotoUrl = new Map<string, string>();
  for (let i = 1; i < logRows.length; i++) {
    const r = logRows[i];
    const invoiceDate = String(r[lInvoiceDate] ?? "").trim();
    if (!invoiceDate) continue;
    const sup = String(r[lSup] ?? "").trim();
    const inv = normalizeInvoice(r[lInv]);
    if (sup && inv) {
      const key = `${sup}::${inv}`;
      if (!byInvoiceKey.has(key)) byInvoiceKey.set(key, invoiceDate);
    }
    const photoUrl = String(r[lPhoto] ?? "").trim();
    if (photoUrl && !byPhotoUrl.has(photoUrl)) {
      byPhotoUrl.set(photoUrl, invoiceDate);
    }
  }
  console.log(`Delivery Log has ${byInvoiceKey.size} distinct invoice keys with invoice_date filled.`);

  // ── Read Inventory Summary ───────────────────────────────────────────────
  const lastSumCol = indexToA1(SUMMARY_SHEET_HEADERS.length - 1);
  const sumRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:${lastSumCol}`
  });
  const sumRows = sumRes.data.values ?? [];
  const sIdx = new Map(SUMMARY_SHEET_HEADERS.map((h, i) => [h, i]));
  const sSup = sIdx.get("supplier")!;
  const sInv = sIdx.get("invoice_or_order_number")!;
  const sInvoiceDate = sIdx.get("invoice_date")!;
  const sPhoto = sIdx.get("photo_url")!;

  interface Edit {
    rowNumber: number;
    summarySupplier: string;
    summaryInvoice: string;
    matchedBy: "invoice" | "photo";
    invoiceDate: string;
  }
  const edits: Edit[] = [];
  let skippedFilled = 0;
  let skippedNoMatch = 0;
  for (let i = 1; i < sumRows.length; i++) {
    const r = sumRows[i];
    const existing = String(r[sInvoiceDate] ?? "").trim();
    if (existing) { skippedFilled++; continue; }
    const sup = String(r[sSup] ?? "").trim();
    const inv = normalizeInvoice(r[sInv]);
    const photoUrl = String(r[sPhoto] ?? "").trim();
    let invoiceDate: string | undefined;
    let matchedBy: "invoice" | "photo" = "invoice";
    if (sup && inv) {
      const key = `${sup}::${inv}`;
      invoiceDate = byInvoiceKey.get(key);
    }
    if (!invoiceDate && photoUrl) {
      invoiceDate = byPhotoUrl.get(photoUrl);
      if (invoiceDate) matchedBy = "photo";
    }
    if (!invoiceDate) { skippedNoMatch++; continue; }
    edits.push({
      rowNumber: i + 1,
      summarySupplier: sup,
      summaryInvoice: inv,
      matchedBy,
      invoiceDate
    });
  }

  console.log(`\nSummary rows: total=${sumRows.length - 1} already-filled=${skippedFilled} no-log-match=${skippedNoMatch} to-update=${edits.length}`);
  for (const e of edits) {
    console.log(`  row ${e.rowNumber}  ${e.summarySupplier}/${e.summaryInvoice}  invoice_date -> ${e.invoiceDate}  (matched by ${e.matchedBy})`);
  }

  if (edits.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const col = indexToA1(sInvoiceDate);
  const updates: sheets_v4.Schema$ValueRange[] = edits.map((e) => ({
    range: `${env.SUMMARY_WORKSHEET_NAME}!${col}${e.rowNumber}`,
    values: [[e.invoiceDate]]
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates }
  });
  console.log(`\nWrote ${updates.length} cell update(s) to ${env.SUMMARY_WORKSHEET_NAME}.`);
}

main().catch((err) => {
  console.error("backfill-summary-invoice-date failed:", err);
  process.exit(1);
});
