/**
 * One-off: re-extract a single Slack-hosted invoice photo with the current prompts,
 * then update existing rows in the Inbound Delivery Log (per-line approx_weight)
 * and the Inventory Summary tab (weight_lb) for the matching (supplier, invoice).
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx src/reextract-one.ts "<slack-url_private_download>"
 *
 * Looks up the existing rows by (supplier, invoice_or_order_number) and updates
 * approx_weight in-place by matching item_code_raw → falls back to item_name_raw.
 * Recomputes the Summary row's weight_lb from the new extraction.
 */
import axios from "axios";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { extractFromImage, guessSupplierFromFilename } from "./extraction.js";
import { SHEET_HEADERS, SUMMARY_SHEET_HEADERS } from "./sheets.js";
import type { Supplier } from "./types.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function normalizeInvoice(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.replace(/^0+/, "") || "0";
}

function normalizeCode(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.replace(/^0+/, "") || "0";
}

function indexToA1(col0: number): string {
  let n = col0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function downloadSlackFile(url: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }
  });
  return Buffer.from(res.data);
}

function mimeForFilename(filename: string): string {
  const f = filename.toLowerCase();
  if (f.endsWith(".pdf")) return "application/pdf";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".heic")) return "image/heic";
  if (f.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function filenameFromUrl(url: string): string {
  const m = url.match(/\/([^\/?#]+)(?:[?#]|$)/);
  return m ? m[1] : "invoice.jpg";
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: tsx src/reextract-one.ts <slack url_private_download>");
    process.exit(1);
  }
  const filename = filenameFromUrl(url);
  console.log(`Downloading ${filename}...`);
  const bytes = await downloadSlackFile(url);
  const mimeType = mimeForFilename(filename);

  const supplierHint: Supplier = guessSupplierFromFilename(filename);
  console.log(`Supplier hint from filename: ${supplierHint}`);
  console.log(`Re-extracting (this calls Anthropic; may take ~30s)...`);
  const extraction = await extractFromImage({ imageBytes: bytes, mimeType, filename, supplierHint });

  const supplier = extraction.supplier;
  const invoice = extraction.invoice_or_order_number;
  console.log(`Extracted: supplier=${supplier} invoice=${invoice} items=${extraction.line_items.length}`);
  for (const it of extraction.line_items) {
    console.log(`  - [${it.item_code_raw ?? "?"}] ${it.item_name_raw} qty=${it.quantity} pack=${it.pack_size_raw} -> approx_weight=${it.approx_weight}`);
  }
  if (!invoice) {
    console.error("No invoice number on the extraction; cannot match existing rows. Aborting.");
    process.exit(1);
  }

  // ── Update Inbound Delivery Log rows ─────────────────────────────────────
  const logRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const logRows = logRes.data.values ?? [];
  const headerToIdx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supIdx = headerToIdx.get("supplier")!;
  const invIdx = headerToIdx.get("invoice_or_order_number")!;
  const codeIdx = headerToIdx.get("item_code_raw")!;
  const nameIdx = headerToIdx.get("item_name_raw")!;
  const weightIdx = headerToIdx.get("approx_weight")!;
  const isFeeIdx = headerToIdx.get("is_fee")!;

  const matchedLogRows: { rowNumber: number; row: string[] }[] = [];
  for (let i = 1; i < logRows.length; i++) {
    const r = logRows[i];
    if ((r[supIdx] ?? "") === supplier && normalizeInvoice(r[invIdx]) === normalizeInvoice(invoice)) {
      matchedLogRows.push({ rowNumber: i + 1, row: r as string[] });
    }
  }
  console.log(`Matched ${matchedLogRows.length} existing Inbound Delivery Log rows for ${supplier}/${invoice}.`);

  const updates: sheets_v4.Schema$ValueRange[] = [];
  let lineUpdates = 0;
  for (const item of extraction.line_items) {
    if (item.approx_weight == null) continue;
    let match = matchedLogRows.find(
      (m) =>
        (m.row[isFeeIdx] ?? "").toString().toUpperCase() !== "TRUE" &&
        item.item_code_raw &&
        normalizeCode(m.row[codeIdx]) === normalizeCode(item.item_code_raw)
    );
    if (!match && item.item_name_raw) {
      match = matchedLogRows.find(
        (m) =>
          (m.row[isFeeIdx] ?? "").toString().toUpperCase() !== "TRUE" &&
          (m.row[nameIdx] ?? "") === item.item_name_raw
      );
    }
    if (!match) {
      console.log(`  ! No matching row for [${item.item_code_raw ?? "?"}] ${item.item_name_raw} — skipping.`);
      continue;
    }
    const colA1 = indexToA1(weightIdx);
    updates.push({
      range: `${env.GOOGLE_WORKSHEET_NAME}!${colA1}${match.rowNumber}`,
      values: [[item.approx_weight]]
    });
    lineUpdates++;
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "USER_ENTERED", data: updates }
    });
  }
  console.log(`Wrote approx_weight to ${lineUpdates} Inbound Delivery Log rows.`);

  // ── Update Inventory Summary row ─────────────────────────────────────────
  const totalWeight = extraction.line_items
    .filter((it) => !it.is_fee)
    .reduce((acc, it) => acc + (typeof it.approx_weight === "number" && Number.isFinite(it.approx_weight) ? it.approx_weight : 0), 0);
  const newWeight = totalWeight > 0 ? Number(totalWeight.toFixed(2)) : null;

  const summaryRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:Z`
  });
  const sumRows = summaryRes.data.values ?? [];
  const sHeader = new Map(SUMMARY_SHEET_HEADERS.map((h, i) => [h, i]));
  const sSup = sHeader.get("supplier")!;
  const sInv = sHeader.get("invoice_or_order_number")!;
  const sW = sHeader.get("weight_lb")!;

  let summaryRowNumber: number | null = null;
  for (let i = 1; i < sumRows.length; i++) {
    if ((sumRows[i][sSup] ?? "") === supplier && normalizeInvoice(sumRows[i][sInv]) === normalizeInvoice(invoice)) {
      summaryRowNumber = i + 1;
      break;
    }
  }
  if (summaryRowNumber == null) {
    console.log(`No matching Inventory Summary row found for ${supplier}/${invoice}; skipping summary update.`);
  } else {
    const colA1 = indexToA1(sW);
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      range: `${env.SUMMARY_WORKSHEET_NAME}!${colA1}${summaryRowNumber}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[newWeight]] }
    });
    console.log(`Updated Inventory Summary row ${summaryRowNumber}: weight_lb=${newWeight}`);
  }
}

main().catch((err) => {
  console.error("re-extract failed:", err);
  process.exit(1);
});
