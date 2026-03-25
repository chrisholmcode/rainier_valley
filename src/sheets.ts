import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { env } from "./config.js";
import { ExtractionResult, EodExtractionResult, EodSheetRow, DeliverySheetRow } from "./types.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const headersInitialized = new Set<string>();

async function ensureHeader(worksheetName: string, headers: string[]): Promise<void> {
  if (headersInitialized.has(worksheetName)) return;
  const sheets = google.sheets({ version: "v4", auth });
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${worksheetName}!1:1` });
  if (!existing.data.values?.[0]?.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      range: `${worksheetName}!1:1`,
      valueInputOption: "RAW",
      requestBody: { values: [headers] }
    });
  }
  headersInitialized.add(worksheetName);
}

export const SHEET_HEADERS = [
  "created_at",
  "supplier",
  "document_type",
  "delivery_date",
  "invoice_or_order_number",
  "destination_org",
  "item_code_raw",
  "item_name_raw",
  "item_name_normalized",
  "quantity",
  "quantity_raw",
  "unit",
  "pack_size_raw",
  "category",
  "unit_cost",
  "line_total",
  "confidence",
  "is_fee",
  "notes",
  "photo_url",
  "slack_channel",
  "slack_message_ts",
  "uploaded_by",
  "warnings_json"
];

export async function ensureSheetHeader(): Promise<void> {
  await ensureHeader(env.GOOGLE_WORKSHEET_NAME, SHEET_HEADERS);
}

export async function appendExtractionRows(params: {
  extraction: ExtractionResult;
  photoUrl: string;
  slackChannel: string;
  slackMessageTs: string;
  uploadedBy: string;
}): Promise<number> {
  const { extraction, photoUrl, slackChannel, slackMessageTs, uploadedBy } = params;

  const rows = extraction.line_items.map((item) => [
    new Date().toISOString(),
    extraction.supplier,
    extraction.document_type,
    extraction.delivery_date,
    extraction.invoice_or_order_number,
    extraction.destination_org,
    item.item_code_raw,
    item.item_name_raw,
    item.item_name_normalized,
    item.quantity,
    item.quantity_raw,
    item.unit,
    item.pack_size_raw,
    item.category,
    item.unit_cost,
    item.line_total,
    item.confidence,
    item.is_fee,
    item.notes,
    photoUrl,
    slackChannel,
    slackMessageTs,
    uploadedBy,
    JSON.stringify(extraction.source_warnings)
  ]);

  const feeRows = extraction.fees.map((fee) => [
    new Date().toISOString(),
    extraction.supplier,
    extraction.document_type,
    extraction.delivery_date,
    extraction.invoice_or_order_number,
    extraction.destination_org,
    null,
    fee.description,
    fee.description,
    null,
    null,
    "ea",
    null,
    "unknown",
    null,
    fee.amount,
    1,
    true,
    "fee",
    photoUrl,
    slackChannel,
    slackMessageTs,
    uploadedBy,
    JSON.stringify(extraction.source_warnings)
  ]);

  const allRows = [...rows, ...feeRows];
  if (!allRows.length) {
    allRows.push([
      new Date().toISOString(),
      extraction.supplier,
      extraction.document_type,
      extraction.delivery_date,
      extraction.invoice_or_order_number,
      extraction.destination_org,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "No line items extracted",
      photoUrl,
      slackChannel,
      slackMessageTs,
      uploadedBy,
      JSON.stringify(extraction.source_warnings)
    ]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: allRows
    }
  });

  return allRows.length;
}

// ── EOD Inventory sheet ───────────────────────────────────────────────────────

export const EOD_SHEET_HEADERS = [
  "recorded_at",
  "date",
  "item_name_raw",
  "item_name_normalized",
  "quantity",
  "quantity_raw",
  "unit",
  "category",
  "notes",
  "confidence",
  "source",
  "slack_channel",
  "slack_message_ts",
  "recorded_by",
  "warnings_json"
];

export async function ensureEodSheetHeader(): Promise<void> {
  await ensureHeader(env.EOD_WORKSHEET_NAME, EOD_SHEET_HEADERS);
}

export async function appendEodRows(params: {
  extraction: EodExtractionResult;
  source: "text" | "voice";
  slackChannel: string;
  slackMessageTs: string;
  recordedBy: string;
}): Promise<number> {
  const { extraction, source, slackChannel, slackMessageTs, recordedBy } = params;
  const now = new Date().toISOString();
  const date = extraction.date ?? new Date().toISOString().slice(0, 10);
  const warningsJson = JSON.stringify(extraction.source_warnings);

  const rows = extraction.line_items.map((item) => [
    now,
    date,
    item.item_name_raw,
    item.item_name_normalized,
    item.quantity,
    item.quantity_raw,
    item.unit,
    item.category,
    item.notes,
    item.confidence,
    source,
    slackChannel,
    slackMessageTs,
    recordedBy,
    warningsJson
  ]);

  if (!rows.length) {
    rows.push([now, date, null, null, null, null, null, null, "No items extracted", null, source, slackChannel, slackMessageTs, recordedBy, warningsJson]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows }
  });

  return rows.length;
}

// ── Assistant read/update functions ──────────────────────────────────────────

function indexToColumn(index: number): string {
  let col = "";
  let n = index;
  do {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return col;
}

export async function readEodRows(params: { date?: string; limit?: number }): Promise<EodSheetRow[]> {
  const { date, limit = 50 } = params;
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.EOD_WORKSHEET_NAME}!A:O` });
  const rows = (res.data.values ?? []).slice(1);
  const mapped: EodSheetRow[] = rows.map((r, i) => ({
    rowIndex: i + 2,
    recorded_at: r[0] ?? "",
    date: r[1] ?? "",
    item_name_raw: r[2] ?? null,
    item_name_normalized: r[3] ?? null,
    quantity: r[4] ?? null,
    quantity_raw: r[5] ?? null,
    unit: r[6] ?? null,
    category: r[7] ?? null,
    notes: r[8] ?? null,
    confidence: r[9] ?? null,
    source: r[10] ?? null,
    slack_channel: r[11] ?? null,
    slack_message_ts: r[12] ?? null,
    recorded_by: r[13] ?? null,
    warnings_json: r[14] ?? null
  }));
  const filtered = date ? mapped.filter((r) => r.date === date) : mapped;
  return filtered.slice(-limit);
}

export async function readDeliveryRows(params: { date?: string; supplier?: string; limit?: number }): Promise<DeliverySheetRow[]> {
  const { date, supplier, limit = 50 } = params;
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.GOOGLE_WORKSHEET_NAME}!A:X` });
  const rows = (res.data.values ?? []).slice(1);
  const mapped: DeliverySheetRow[] = rows.map((r, i) => ({
    rowIndex: i + 2,
    created_at: r[0] ?? "",
    supplier: r[1] ?? "",
    document_type: r[2] ?? "",
    delivery_date: r[3] ?? null,
    invoice_or_order_number: r[4] ?? null,
    destination_org: r[5] ?? null,
    item_code_raw: r[6] ?? null,
    item_name_raw: r[7] ?? null,
    item_name_normalized: r[8] ?? null,
    quantity: r[9] ?? null,
    quantity_raw: r[10] ?? null,
    unit: r[11] ?? null,
    pack_size_raw: r[12] ?? null,
    category: r[13] ?? null,
    unit_cost: r[14] ?? null,
    line_total: r[15] ?? null,
    confidence: r[16] ?? null,
    is_fee: r[17] ?? null,
    notes: r[18] ?? null,
    photo_url: r[19] ?? null,
    slack_channel: r[20] ?? null,
    slack_message_ts: r[21] ?? null,
    uploaded_by: r[22] ?? null,
    warnings_json: r[23] ?? null
  }));
  const filtered = mapped.filter((r) => {
    if (date && r.delivery_date !== date) return false;
    if (supplier && r.supplier !== supplier) return false;
    return true;
  });
  return filtered.slice(-limit);
}

export async function updateSheetCell(params: {
  worksheetName: string;
  rowIndex: number;
  columnName: string;
  newValue: string | number | boolean | null;
}): Promise<void> {
  const { worksheetName, rowIndex, columnName, newValue } = params;
  const headers = worksheetName === env.EOD_WORKSHEET_NAME ? EOD_SHEET_HEADERS : SHEET_HEADERS;
  const colIndex = headers.indexOf(columnName);
  if (colIndex === -1) throw new Error(`Unknown column: ${columnName}`);
  const colLetter = indexToColumn(colIndex);
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${worksheetName}!${colLetter}${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[newValue]] }
  });
}
