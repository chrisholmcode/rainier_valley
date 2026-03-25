import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { env } from "./config.js";
import { ExtractionResult, EodExtractionResult } from "./types.js";

function getGoogleAuth(): GoogleAuth {
  if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
  }

  return new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const SHEET_HEADERS = [
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
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${env.GOOGLE_WORKSHEET_NAME}!1:1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range
  });

  if (existing.data.values?.[0]?.length) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: {
      values: [SHEET_HEADERS]
    }
  });
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

  const auth = getGoogleAuth();
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

const EOD_SHEET_HEADERS = [
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
  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const range = `${env.EOD_WORKSHEET_NAME}!1:1`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range
  });

  if (existing.data.values?.[0]?.length) {
    return;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [EOD_SHEET_HEADERS] }
  });
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

  const auth = getGoogleAuth();
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:O`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows }
  });

  return rows.length;
}
