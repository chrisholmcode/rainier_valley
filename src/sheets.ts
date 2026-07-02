import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { env } from "./config.js";
import { ExtractionResult, EodExtractionResult, EodSheetRow, DeliverySheetRow, ProgramType, ExtractionTrace } from "./types.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const headersInitialized = new Set<string>();
const tabsKnownToExist = new Set<string>();

async function ensureTabExists(worksheetName: string): Promise<void> {
  if (tabsKnownToExist.has(worksheetName)) return;
  const sheets = google.sheets({ version: "v4", auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID });
  const tabs = (meta.data.sheets ?? []).map((s) => s.properties?.title).filter((t): t is string => Boolean(t));
  for (const t of tabs) tabsKnownToExist.add(t);
  if (tabsKnownToExist.has(worksheetName)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: worksheetName } } }] }
  });
  tabsKnownToExist.add(worksheetName);
}

// Sheets grids have a fixed columnCount that does NOT auto-grow when you write
// past the last column; you have to appendDimension. Without this, writing to
// AC298 on an Inbound Delivery Log that was sized at 28 columns fails with
// "exceeds grid limits".
async function ensureColumnCount(worksheetName: string, requiredCols: number): Promise<void> {
  const sheets = google.sheets({ version: "v4", auth });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID });
  const sheet = meta.data.sheets?.find((s) => s.properties?.title === worksheetName);
  const sheetId = sheet?.properties?.sheetId;
  if (sheetId == null) return;
  const currentCols = sheet?.properties?.gridProperties?.columnCount ?? 26;
  if (currentCols >= requiredCols) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      requests: [{
        appendDimension: {
          sheetId,
          dimension: "COLUMNS",
          length: requiredCols - currentCols
        }
      }]
    }
  });
}

async function ensureHeader(worksheetName: string, headers: string[]): Promise<void> {
  if (headersInitialized.has(worksheetName)) return;
  await ensureTabExists(worksheetName);
  await ensureColumnCount(worksheetName, headers.length);
  const sheets = google.sheets({ version: "v4", auth });
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${worksheetName}!1:1` });
  const existingRow = existing.data.values?.[0] ?? [];
  const missingColumns = headers.some((h) => !existingRow.includes(h));
  if (!existingRow.length || missingColumns) {
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
  "quantity_ordered",
  "quantity",
  "quantity_raw",
  "unit",
  "pack_size_raw",
  "approx_weight",
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
  "warnings_json",
  "donor_org",
  "is_donation",
  "approved_at",
  "approved_by"
];

export async function ensureSheetHeader(): Promise<void> {
  await ensureHeader(env.GOOGLE_WORKSHEET_NAME, SHEET_HEADERS);
}

export const TRACE_SHEET_HEADERS = [
  "created_at",
  "filename",
  "supplier",
  "supplier_hint",
  "delivery_date",
  "invoice_or_order_number",
  "destination_org",
  "photo_url",
  "line_item_count",
  "confidence_avg",
  "model",
  "input_tokens",
  "output_tokens",
  "cache_creation_tokens",
  "cache_read_tokens",
  "caruso_reconcile_hits",
  "caruso_reconcile_overwrites",
  "source_warnings",
  "extracted_json",
  "thinking_1",
  "thinking_2",
  "thinking_3",
  "thinking_truncated"
];

// Sheets caps at 50k chars per cell; leave headroom for JSON escaping.
const TRACE_CELL_LIMIT = 45_000;

function chunkForCells(text: string, chunkSize: number, maxChunks: number): { chunks: string[]; truncated: boolean } {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length && chunks.length < maxChunks) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize;
  }
  return { chunks, truncated: i < text.length };
}

export async function appendExtractionTrace(params: {
  trace: ExtractionTrace;
  extraction: ExtractionResult;
  photoUrl: string;
  carusoReconcileHits: number;
  carusoReconcileOverwrites: number;
}): Promise<void> {
  const { trace, extraction, photoUrl, carusoReconcileHits, carusoReconcileOverwrites } = params;
  await ensureHeader(env.EXTRACTION_TRACES_WORKSHEET_NAME, TRACE_SHEET_HEADERS);

  const { chunks: thinkingChunks, truncated: thinkingTruncated } = chunkForCells(trace.thinking, TRACE_CELL_LIMIT, 3);
  const confidences = extraction.line_items.map((li) => li.confidence).filter((c) => typeof c === "number");
  const confidenceAvg = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;

  const extractedJsonRaw = JSON.stringify(extraction);
  const extractedJson = extractedJsonRaw.length > TRACE_CELL_LIMIT
    ? extractedJsonRaw.slice(0, TRACE_CELL_LIMIT) + "…[truncated]"
    : extractedJsonRaw;

  const row = [
    new Date().toISOString(),
    trace.filename,
    extraction.supplier,
    trace.supplierHint,
    extraction.delivery_date,
    extraction.invoice_or_order_number,
    extraction.destination_org,
    photoUrl,
    extraction.line_items.length,
    confidenceAvg,
    trace.model,
    trace.inputTokens,
    trace.outputTokens,
    trace.cacheCreationTokens,
    trace.cacheReadTokens,
    carusoReconcileHits,
    carusoReconcileOverwrites,
    JSON.stringify(extraction.source_warnings),
    extractedJson,
    thinkingChunks[0] ?? "",
    thinkingChunks[1] ?? "",
    thinkingChunks[2] ?? "",
    thinkingTruncated
  ];

  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EXTRACTION_TRACES_WORKSHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

// Sheets' USER_ENTERED input parses numeric-looking strings as numbers, which
// silently strips leading zeros from item SKUs (e.g. Caruso "00683" -> 683).
// Prefixing with an apostrophe forces text storage; the apostrophe itself is
// stripped from the displayed value.
function asSheetCode(v: string | null): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return s;
  if (s.startsWith("'")) return s;
  return `'${s}`;
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
    asSheetCode(item.item_code_raw),
    item.item_name_raw,
    item.item_name_normalized,
    item.quantity_ordered,
    item.quantity,
    item.quantity_raw,
    item.unit,
    item.pack_size_raw,
    item.approx_weight,
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
    JSON.stringify(extraction.source_warnings),
    extraction.donor_org,
    extraction.is_donation,
    null,
    null
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
    null,
    "ea",
    null,
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
    JSON.stringify(extraction.source_warnings),
    extraction.donor_org,
    extraction.is_donation,
    null,
    null
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
      null,
      null,
      "No line items extracted",
      photoUrl,
      slackChannel,
      slackMessageTs,
      uploadedBy,
      JSON.stringify(extraction.source_warnings),
      extraction.donor_org,
      extraction.is_donation,
      null,
      null
    ]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:AD`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: allRows
    }
  });

  return allRows.length;
}

// ── Inventory Summary sheet (one row per shipment, for Salesforce) ───────────

export const SUMMARY_SHEET_HEADERS = [
  "created_at",
  "delivery_date",
  "supplier",
  "weight_lb",
  "unit",
  "invoice_or_order_number",
  "food_type",
  "is_food",
  "cost",
  "donation",
  "photo_url"
];

const DONATION_SUPPLIERS = new Set<string>(["nw_harvest", "food_lifeline"]);

interface SummaryRollup {
  weight_lb: number | null;
  food_type: string | null;
  is_food: boolean;
  cost: number | null;
  donation: boolean;
}

function rollupExtraction(extraction: ExtractionResult): SummaryRollup {
  const nonFeeItems = extraction.line_items.filter((item) => !item.is_fee);

  let totalWeight = 0;
  let hasWeight = false;
  const weightByCategory = new Map<string, number>();
  const categoryOrder: string[] = [];

  for (const item of nonFeeItems) {
    const w = typeof item.approx_weight === "number" ? item.approx_weight : null;
    if (w != null && Number.isFinite(w)) {
      totalWeight += w;
      hasWeight = true;
      if (item.category) {
        const prev = weightByCategory.get(item.category) ?? 0;
        if (prev === 0) categoryOrder.push(item.category);
        weightByCategory.set(item.category, prev + w);
      }
    }
  }

  let foodType: string | null = null;
  if (weightByCategory.size > 0) {
    let best: string | null = null;
    let bestWeight = -1;
    for (const cat of categoryOrder) {
      const w = weightByCategory.get(cat) ?? 0;
      if (w > bestWeight) {
        best = cat;
        bestWeight = w;
      }
    }
    foodType = best;
  } else if (nonFeeItems.length > 0) {
    foodType = nonFeeItems[0].category ?? null;
  }

  const isFood = nonFeeItems.some((item) => item.category && item.category !== "non_food");

  let cost: number | null = extraction.totals.grand_total ?? null;
  if (cost == null) {
    let summed = 0;
    let any = false;
    for (const item of extraction.line_items) {
      if (typeof item.line_total === "number" && Number.isFinite(item.line_total)) {
        summed += item.line_total;
        any = true;
      }
    }
    for (const fee of extraction.fees) {
      if (typeof fee.amount === "number" && Number.isFinite(fee.amount)) {
        summed += fee.amount;
        any = true;
      }
    }
    if (any) cost = summed;
  }

  return {
    weight_lb: hasWeight ? Number(totalWeight.toFixed(2)) : null,
    food_type: foodType,
    is_food: isFood,
    cost,
    donation: extraction.is_donation ?? DONATION_SUPPLIERS.has(extraction.supplier)
  };
}

export async function ensureSummarySheetHeader(): Promise<void> {
  await ensureHeader(env.SUMMARY_WORKSHEET_NAME, SUMMARY_SHEET_HEADERS);
}

export async function appendSummaryRow(params: {
  extraction: ExtractionResult;
  photoUrl: string;
}): Promise<void> {
  const { extraction, photoUrl } = params;
  const rollup = rollupExtraction(extraction);

  const row = [
    new Date().toISOString(),
    extraction.delivery_date,
    extraction.supplier,
    rollup.weight_lb,
    "lb",
    extraction.invoice_or_order_number,
    rollup.food_type,
    rollup.is_food,
    rollup.cost,
    rollup.donation,
    photoUrl
  ];

  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:K`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
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
  "warnings_json",
  "program_type"
];

export async function ensureEodSheetHeader(): Promise<void> {
  await ensureHeader(env.EOD_WORKSHEET_NAME, EOD_SHEET_HEADERS);
}

export async function appendEodRows(params: {
  extraction: EodExtractionResult;
  source: "text" | "voice" | "whiteboard";
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
    warningsJson,
    item.program_type ?? ""
  ]);

  if (!rows.length) {
    rows.push([now, date, null, null, null, null, null, null, "No items extracted", null, source, slackChannel, slackMessageTs, recordedBy, warningsJson, ""]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:P`,
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

function normalizeProgramType(v: unknown): ProgramType | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "home_delivery" || s === "in_person_shopping" || s === "pre_made_bags" || s === "unknown") {
    return s as ProgramType;
  }
  return null;
}

export async function readEodRows(params: { date?: string; limit?: number }): Promise<EodSheetRow[]> {
  const { date, limit = 50 } = params;
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.EOD_WORKSHEET_NAME}!A:P` });
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
    warnings_json: r[14] ?? null,
    program_type: normalizeProgramType(r[15])
  }));
  const filtered = date ? mapped.filter((r) => r.date === date) : mapped;
  return filtered.slice(-limit);
}

export async function readDeliveryRows(params: { date?: string; supplier?: string; limit?: number }): Promise<DeliverySheetRow[]> {
  const { date, supplier, limit = 50 } = params;
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.GOOGLE_WORKSHEET_NAME}!A:AD` });
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
    quantity_ordered: r[9] ?? null,
    quantity: r[10] ?? null,
    quantity_raw: r[11] ?? null,
    unit: r[12] ?? null,
    pack_size_raw: r[13] ?? null,
    approx_weight: r[14] ?? null,
    category: r[15] ?? null,
    unit_cost: r[16] ?? null,
    line_total: r[17] ?? null,
    confidence: r[18] ?? null,
    is_fee: r[19] ?? null,
    notes: r[20] ?? null,
    photo_url: r[21] ?? null,
    slack_channel: r[22] ?? null,
    slack_message_ts: r[23] ?? null,
    uploaded_by: r[24] ?? null,
    warnings_json: r[25] ?? null,
    donor_org: r[26] ?? null,
    is_donation: r[27] ?? null,
    approved_at: r[28] ?? null,
    approved_by: r[29] ?? null
  }));
  const filtered = mapped.filter((r) => {
    if (date && r.delivery_date !== date) return false;
    if (supplier && r.supplier !== supplier) return false;
    return true;
  });
  return filtered.slice(-limit);
}

// ── Corrections Log (every human edit appends one row) ──────────────────────

export const CORRECTIONS_LOG_HEADERS = [
  "timestamp",
  "user",
  "slip_key",
  "sheet",
  "row_index",
  "field",
  "old_value",
  "new_value",
  "reason"
];

export async function ensureCorrectionsLogHeader(): Promise<void> {
  await ensureHeader(env.CORRECTIONS_LOG_WORKSHEET_NAME, CORRECTIONS_LOG_HEADERS);
}

export async function ensureExtractionTracesHeader(): Promise<void> {
  await ensureHeader(env.EXTRACTION_TRACES_WORKSHEET_NAME, TRACE_SHEET_HEADERS);
}

export async function appendCorrectionRow(params: {
  user: string;
  slipKey: string;
  sheet: string;
  rowIndex: number;
  field: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
  reason: string | null;
}): Promise<void> {
  await ensureCorrectionsLogHeader();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.CORRECTIONS_LOG_WORKSHEET_NAME}!A:I`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        new Date().toISOString(),
        params.user,
        params.slipKey,
        params.sheet,
        params.rowIndex,
        params.field,
        params.oldValue == null ? "" : String(params.oldValue),
        params.newValue == null ? "" : String(params.newValue),
        params.reason ?? ""
      ]]
    }
  });
}

// ── Slip-level helpers (a "slip" = all inbound rows sharing one photo_url) ───

export interface SlipSummary {
  slipKey: string; // photo_url
  supplier: string;
  document_type: string;
  delivery_date: string | null;
  invoice_or_order_number: string | null;
  destination_org: string | null;
  donor_org: string | null;
  is_donation: string | null;
  created_at: string;
  photo_url: string;
  rowCount: number;
  rowIndexes: number[];
  minConfidence: number | null;
  approved: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  uploaded_by: string | null;
}

export function groupSlips(rows: DeliverySheetRow[]): SlipSummary[] {
  const byKey = new Map<string, DeliverySheetRow[]>();
  for (const r of rows) {
    const key = r.photo_url ?? "";
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const summaries: SlipSummary[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    let minConf: number | null = null;
    let allApproved = true;
    let approvedAt: string | null = null;
    let approvedBy: string | null = null;
    for (const r of group) {
      const c = r.confidence ? parseFloat(r.confidence) : NaN;
      if (Number.isFinite(c)) {
        if (minConf === null || c < minConf) minConf = c;
      }
      if (!r.approved_at) {
        allApproved = false;
      } else {
        approvedAt = r.approved_at;
        approvedBy = r.approved_by;
      }
    }
    summaries.push({
      slipKey: key,
      supplier: first.supplier,
      document_type: first.document_type,
      delivery_date: first.delivery_date,
      invoice_or_order_number: first.invoice_or_order_number,
      destination_org: first.destination_org,
      donor_org: first.donor_org,
      is_donation: first.is_donation,
      created_at: first.created_at,
      photo_url: key,
      rowCount: group.length,
      rowIndexes: group.map((r) => r.rowIndex),
      minConfidence: minConf,
      approved: allApproved && group.length > 0,
      approvedAt,
      approvedBy,
      uploaded_by: first.uploaded_by
    });
  }
  summaries.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return summaries;
}

export function slipNeedsReview(slip: SlipSummary, threshold: number): boolean {
  if (slip.approved) return false;
  if (slip.minConfidence !== null && slip.minConfidence < threshold) return true;
  return !slip.approved;
}

export async function stampSlipApproval(params: {
  slipKey: string;
  rowIndexes: number[];
  approvedBy: string;
}): Promise<void> {
  const { slipKey, rowIndexes, approvedBy } = params;
  void slipKey;
  const approvedAtCol = indexToColumn(SHEET_HEADERS.indexOf("approved_at"));
  const approvedByCol = indexToColumn(SHEET_HEADERS.indexOf("approved_by"));
  const now = new Date().toISOString();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: rowIndexes.flatMap((rowIndex) => [
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedAtCol}${rowIndex}`, values: [[now]] },
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedByCol}${rowIndex}`, values: [[approvedBy]] }
      ])
    }
  });
}

export async function clearSlipApproval(rowIndexes: number[]): Promise<void> {
  const approvedAtCol = indexToColumn(SHEET_HEADERS.indexOf("approved_at"));
  const approvedByCol = indexToColumn(SHEET_HEADERS.indexOf("approved_by"));
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: rowIndexes.flatMap((rowIndex) => [
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedAtCol}${rowIndex}`, values: [[""]] },
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedByCol}${rowIndex}`, values: [[""]] }
      ])
    }
  });
}

// ── Rerun Inventory Summary rollup for a single slip ────────────────────────

export async function recomputeSummaryForSlip(slipRows: DeliverySheetRow[]): Promise<void> {
  if (slipRows.length === 0) return;
  const first = slipRows[0];
  const supplier = first.supplier;
  const invoice = first.invoice_or_order_number ?? "";
  const photoUrl = first.photo_url ?? "";

  const lineItems = slipRows.filter((r) => !isFeeFlag(r.is_fee)).map(rowToLineItemForSummary);
  const fees = slipRows.filter((r) => isFeeFlag(r.is_fee)).map(rowToFeeItemForSummary);
  const totals: ExtractionResult["totals"] = { subtotal: null, tax: null, grand_total: null };
  const extraction: ExtractionResult = {
    document_type: (first.document_type as ExtractionResult["document_type"]) ?? "unknown",
    supplier: (first.supplier as ExtractionResult["supplier"]) ?? "unknown",
    delivery_date: first.delivery_date,
    invoice_or_order_number: first.invoice_or_order_number,
    destination_org: first.destination_org,
    donor_org: first.donor_org,
    is_donation: parseBoolNullable(first.is_donation),
    line_items: lineItems,
    fees,
    totals,
    source_warnings: []
  };

  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:Z`
  });
  const allRows = res.data.values ?? [];
  let matchRowIndex = -1;
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    const rSupplier = row[2] ?? "";
    const rInvoice = row[5] ?? "";
    const rPhoto = row[10] ?? "";
    if (rPhoto && photoUrl && rPhoto === photoUrl) { matchRowIndex = i + 1; break; }
    if (rSupplier === supplier && rInvoice && invoice && rInvoice === invoice) { matchRowIndex = i + 1; break; }
  }

  if (matchRowIndex === -1) {
    await appendSummaryRow({ extraction, photoUrl });
    return;
  }

  const rollup = rollupExtraction(extraction);
  const row = [
    new Date().toISOString(),
    extraction.delivery_date,
    extraction.supplier,
    rollup.weight_lb,
    "lb",
    extraction.invoice_or_order_number,
    rollup.food_type,
    rollup.is_food,
    rollup.cost,
    rollup.donation,
    photoUrl
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A${matchRowIndex}:K${matchRowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] }
  });
}

function parseBoolNullable(v: string | null): boolean | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

function isFeeFlag(v: string | null): boolean {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function rowToLineItemForSummary(r: DeliverySheetRow): ExtractionResult["line_items"][number] {
  return {
    item_code_raw: r.item_code_raw,
    item_name_raw: r.item_name_raw,
    item_name_normalized: r.item_name_normalized,
    quantity_ordered: r.quantity_ordered ? parseFloat(r.quantity_ordered) : null,
    quantity: r.quantity ? parseFloat(r.quantity) : null,
    quantity_raw: r.quantity_raw,
    unit: (r.unit as ExtractionResult["line_items"][number]["unit"]) ?? null,
    pack_size_raw: r.pack_size_raw,
    approx_weight: r.approx_weight ? parseFloat(r.approx_weight) : null,
    category: ((r.category as ExtractionResult["line_items"][number]["category"]) ?? "unknown"),
    unit_cost: r.unit_cost ? parseFloat(r.unit_cost) : null,
    line_total: r.line_total ? parseFloat(r.line_total) : null,
    is_fee: false,
    notes: r.notes,
    confidence: r.confidence ? parseFloat(r.confidence) : 0
  };
}

function rowToFeeItemForSummary(r: DeliverySheetRow): ExtractionResult["fees"][number] {
  return {
    description: r.item_name_raw ?? r.notes ?? "fee",
    amount: r.line_total ? parseFloat(r.line_total) : null
  };
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
  const writeValue = columnName === "item_code_raw" && typeof newValue === "string"
    ? asSheetCode(newValue)
    : newValue;
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${worksheetName}!${colLetter}${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[writeValue]] }
  });
}
