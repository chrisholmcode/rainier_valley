import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { env } from "./config.js";
import { ExtractionResult, EodExtractionResult, EodSheetRow, DeliverySheetRow, ProgramType, ExtractionTrace, PromptSuggestionRow, PromptSuggestionStatus } from "./types.js";
import { ensureRescueSkeleton, normalizeRescueSlip } from "./extraction.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const headersInitialized = new Set<string>();
const tabsKnownToExist = new Set<string>();

function indexToColumnLetter(col0: number): string {
  let n = col0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

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
  "invoice_date",
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
  "approved_by",
  "donor_name",
  "donor_email",
  "donor_anonymous",
  "send_receipt",
  "is_food_drive",
  "is_food"
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

// True for food subcategories, false for non_food, null for unknown/other.
// Fees are always non-food (see appendExtractionRows fee path).
function categoryIsFood(category: string | null | undefined): boolean | null {
  switch (category) {
    case "produce":
    case "meat_protein":
    case "dairy":
    case "shelf_stable":
    case "frozen":
      return true;
    case "non_food":
      return false;
    default:
      return null;
  }
}

// All Sheets writes go out with valueInputOption: "RAW" — JS types round-trip
// verbatim (numbers stay numbers, booleans stay booleans, strings stay
// strings). This eliminates the class of bug where Sheets' USER_ENTERED
// coerces numeric-looking identifiers (Slack ts, item codes, invoice #s)
// into floats and display-truncates them.
//
// Bot-append paths pass JS-typed values directly, so no coercion needed.
// The Review-UI edit path (updateSheetCells) receives JSON strings from
// the browser, so we coerce here based on column name.
const NUMERIC_COLUMNS = new Set([
  "quantity_ordered", "quantity", "approx_weight", "unit_cost", "line_total", "confidence"
]);
const BOOLEAN_COLUMNS = new Set([
  "is_fee", "is_donation", "donor_anonymous", "send_receipt", "is_food_drive", "is_food"
]);
function coerceForColumn(
  columnName: string,
  value: string | number | boolean | null
): string | number | boolean | null {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (s === "") return null;
  if (NUMERIC_COLUMNS.has(columnName)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (BOOLEAN_COLUMNS.has(columnName)) {
    const lower = s.toLowerCase();
    if (lower === "true" || lower === "1" || lower === "yes") return true;
    if (lower === "false" || lower === "0" || lower === "no") return false;
    return s;
  }
  return s;
}

export async function appendExtractionRows(params: {
  extraction: ExtractionResult;
  photoUrl: string;
  slackChannel: string;
  slackMessageTs: string;
  uploadedBy: string;
  skipAutoApprove?: boolean;
}): Promise<number> {
  const { extraction, photoUrl, slackChannel, slackMessageTs, uploadedBy, skipAutoApprove } = params;

  // Defense-in-depth invariant enforcement. index.ts runs both of these
  // in the Slack file-upload path, but reextract-one.ts and any future
  // caller could bypass them. Both helpers are idempotent — calling here
  // even after index.ts ran is a no-op. Guarantees every grocery_rescue
  // slip landing in the sheet has: (a) canonical donor_org + synthesized
  // shipment ID, (b) all 10 category skeleton rows.
  normalizeRescueSlip(extraction);
  ensureRescueSkeleton(extraction);

  // Auto-approve on write if the slip's min line-item confidence meets the
  // review threshold. Reviewers can still un-approve via the /review UI (any
  // edit clears approval). "auto-approved" tags the source so we can tell
  // human vs machine approvals apart in the sheet. Callers can force
  // human review by passing skipAutoApprove (e.g., possible duplicate).
  const lineConfidences = extraction.line_items
    .map((li) => li.confidence)
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
  const minConfidence = lineConfidences.length ? Math.min(...lineConfidences) : null;
  const autoApprove = !skipAutoApprove && minConfidence !== null && minConfidence >= env.REVIEW_CONFIDENCE_THRESHOLD;
  const approvedAt = autoApprove ? new Date().toISOString() : null;
  const approvedBy = autoApprove ? "auto-approved" : null;

  const rows = extraction.line_items.map((item) => [
    new Date().toISOString(),
    extraction.supplier,
    extraction.document_type,
    extraction.invoice_date,
    extraction.delivery_date,
    extraction.invoice_or_order_number,
    extraction.destination_org,
    item.item_code_raw,
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
    approvedAt,
    approvedBy,
    null,
    null,
    null,
    null,
    null,
    categoryIsFood(item.category)
  ]);

  const feeRows = extraction.fees.map((fee) => [
    new Date().toISOString(),
    extraction.supplier,
    extraction.document_type,
    extraction.invoice_date,
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
    approvedAt,
    approvedBy,
    null,
    null,
    null,
    null,
    null,
    false
  ]);

  const allRows = [...rows, ...feeRows];
  if (!allRows.length) {
    allRows.push([
      new Date().toISOString(),
      extraction.supplier,
      extraction.document_type,
      extraction.invoice_date,
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
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  // Dedupe: skip if the Inbound Delivery Log already has rows for this
  // photo_url OR (supplier, invoice_or_order_number). Re-uploads after a
  // Railway restart bypass the in-memory dedupes in index.ts, so this is
  // the durable guard. Update-in-place is not the right move here because a
  // reviewer may have already corrected fields on the existing rows.
  const supIdx = SHEET_HEADERS.indexOf("supplier");
  const invIdx = SHEET_HEADERS.indexOf("invoice_or_order_number");
  const photoIdx = SHEET_HEADERS.indexOf("photo_url");
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${indexToColumnLetter(SHEET_HEADERS.length - 1)}`
  });
  const existingRows = existing.data.values ?? [];
  for (let i = 1; i < existingRows.length; i++) {
    const r = existingRows[i];
    const rPhoto = r[photoIdx] ?? "";
    const rSupplier = r[supIdx] ?? "";
    const rInvoice = r[invIdx] ?? "";
    if (rPhoto && photoUrl && rPhoto === photoUrl) {
      console.log(`appendExtractionRows: skipping — photo_url already logged (${photoUrl})`);
      return 0;
    }
    if (
      extraction.supplier !== "unknown" &&
      extraction.invoice_or_order_number &&
      rSupplier === extraction.supplier &&
      rInvoice === extraction.invoice_or_order_number
    ) {
      console.log(`appendExtractionRows: skipping — ${extraction.supplier}/${extraction.invoice_or_order_number} already logged`);
      return 0;
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${indexToColumnLetter(SHEET_HEADERS.length - 1)}`,
    valueInputOption: "RAW",
    requestBody: {
      values: allRows
    }
  });

  return allRows.length;
}

// ── In-kind donation intake (web form → one delivery row + one summary row) ──

export interface InKindDonationSubmission {
  submissionId: string;
  donorName: string;
  donorEmail: string;
  donorAnonymous: boolean;
  sendReceipt: boolean;
  isFoodDrive: boolean;
  foodDriveOrg: string | null;
  category: "food" | "non_food";
  approxWeightLb: number | null;
  quantity: number | null;
  unit: string | null;
  notes: string | null;
  submittedBy: string;
}

export async function appendInKindDonationRow(sub: InKindDonationSubmission): Promise<void> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const displayName = sub.donorAnonymous ? "Anonymous" : sub.donorName;
  const rowCategory = sub.category === "food" ? "unknown" : "non_food";
  const itemName = sub.category === "food" ? "In-kind food donation" : "In-kind non-food donation";
  const row = [
    now,
    "in_kind",
    "in_kind_donation",
    today,
    today,
    sub.submissionId,
    "Rainier Valley Food Bank",
    null,
    itemName,
    itemName,
    null,
    sub.quantity,
    sub.quantity !== null ? String(sub.quantity) : null,
    sub.unit,
    null,
    sub.approxWeightLb,
    rowCategory,
    null,
    null,
    1,
    false,
    sub.notes,
    `donate://${sub.submissionId}`,
    "web-donate",
    sub.submissionId,
    sub.submittedBy,
    JSON.stringify([]),
    sub.foodDriveOrg,
    true,
    now,
    "auto-approved",
    displayName,
    sub.donorEmail,
    sub.donorAnonymous,
    sub.sendReceipt,
    sub.isFoodDrive,
    sub.category === "food"
  ];
  if (row.length !== SHEET_HEADERS.length) {
    throw new Error(`appendInKindDonationRow: row width ${row.length} != SHEET_HEADERS ${SHEET_HEADERS.length}`);
  }
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${indexToColumnLetter(SHEET_HEADERS.length - 1)}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

export async function appendInKindSummaryRow(sub: InKindDonationSubmission): Promise<void> {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const row = [
    now,
    today,
    today,
    "in_kind",
    sub.approxWeightLb ?? null,
    "lb",
    sub.submissionId,
    sub.category,
    sub.category === "food",
    0,
    true,
    `donate://${sub.submissionId}`
  ];
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:${indexToColumnLetter(SUMMARY_SHEET_HEADERS.length - 1)}`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

// ── Inventory Summary sheet (one row per shipment, for Salesforce) ───────────

export const SUMMARY_SHEET_HEADERS = [
  "created_at",
  "invoice_date",
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

const DONATION_SUPPLIERS = new Set<string>(["nw_harvest", "food_lifeline", "grocery_rescue"]);

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
    extraction.invoice_date,
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

  // Dedupe: if a Summary row already exists for this photo_url OR
  // (supplier, invoice_or_order_number), update in place instead of appending.
  // Re-uploads of the same slip after a Railway restart bypass the in-memory
  // dedupes in index.ts, so this is the durable guard.
  const sSupIdx = SUMMARY_SHEET_HEADERS.indexOf("supplier");
  const sInvIdx = SUMMARY_SHEET_HEADERS.indexOf("invoice_or_order_number");
  const sPhotoIdx = SUMMARY_SHEET_HEADERS.indexOf("photo_url");
  const supplier = extraction.supplier;
  const invoice = extraction.invoice_or_order_number ?? "";
  const summaryRange = `${env.SUMMARY_WORKSHEET_NAME}!A:${indexToColumnLetter(SUMMARY_SHEET_HEADERS.length - 1)}`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: summaryRange
  });
  const allRows = existing.data.values ?? [];
  let matchRowIndex = -1;
  for (let i = 1; i < allRows.length; i++) {
    const r = allRows[i];
    const rSupplier = r[sSupIdx] ?? "";
    const rInvoice = r[sInvIdx] ?? "";
    const rPhoto = r[sPhotoIdx] ?? "";
    if (rPhoto && photoUrl && rPhoto === photoUrl) { matchRowIndex = i + 1; break; }
    if (rSupplier === supplier && rInvoice && invoice && rInvoice === invoice) { matchRowIndex = i + 1; break; }
  }

  const lastCol = indexToColumnLetter(SUMMARY_SHEET_HEADERS.length - 1);
  if (matchRowIndex !== -1) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      range: `${env.SUMMARY_WORKSHEET_NAME}!A${matchRowIndex}:${lastCol}${matchRowIndex}`,
      valueInputOption: "RAW",
      requestBody: { values: [row] }
    });
    return;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: summaryRange,
    valueInputOption: "RAW",
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
  "program_type",
  "approved_at",
  "approved_by",
  "photo_url"
];

const EOD_LAST_COL = String.fromCharCode(64 + EOD_SHEET_HEADERS.length); // A..Z single-letter only; safe up to 26 cols

export async function ensureEodSheetHeader(): Promise<void> {
  await ensureHeader(env.EOD_WORKSHEET_NAME, EOD_SHEET_HEADERS);
}

export async function appendEodRows(params: {
  extraction: EodExtractionResult;
  source: "text" | "voice" | "whiteboard";
  slackChannel: string;
  slackMessageTs: string;
  recordedBy: string;
  photoUrl?: string | null;
  autoApprove?: boolean;
}): Promise<number> {
  const { extraction, source, slackChannel, slackMessageTs, recordedBy, photoUrl, autoApprove } = params;
  const now = new Date().toISOString();
  const date = extraction.date ?? new Date().toISOString().slice(0, 10);
  const warningsJson = JSON.stringify(extraction.source_warnings);
  const approvedAt = autoApprove ? now : "";
  const approvedBy = autoApprove ? "auto-approved" : "";
  const photo = photoUrl ?? "";

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
    item.program_type ?? "",
    approvedAt,
    approvedBy,
    photo
  ]);

  if (!rows.length) {
    rows.push([now, date, null, null, null, null, null, null, "No items extracted", null, source, slackChannel, slackMessageTs, recordedBy, warningsJson, "", approvedAt, approvedBy, photo]);
  }

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:${EOD_LAST_COL}`,
    valueInputOption: "RAW",
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
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.EOD_WORKSHEET_NAME}!A:${EOD_LAST_COL}` });
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
    program_type: normalizeProgramType(r[15]),
    approved_at: r[16] || null,
    approved_by: r[17] || null,
    photo_url: r[18] || null
  }));
  const filtered = date ? mapped.filter((r) => r.date === date) : mapped;
  return filtered.slice(-limit);
}

export async function readDeliveryRows(params: { date?: string; supplier?: string; limit?: number }): Promise<DeliverySheetRow[]> {
  const { date, supplier, limit = 50 } = params;
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID, range: `${env.GOOGLE_WORKSHEET_NAME}!A:${indexToColumnLetter(SHEET_HEADERS.length - 1)}` });
  const rows = (res.data.values ?? []).slice(1);
  const h = (name: string) => SHEET_HEADERS.indexOf(name);
  const idxCreated = h("created_at");
  const idxSupplier = h("supplier");
  const idxDocType = h("document_type");
  const idxInvoiceDate = h("invoice_date");
  const idxDelivery = h("delivery_date");
  const idxInv = h("invoice_or_order_number");
  const idxDest = h("destination_org");
  const idxItemCode = h("item_code_raw");
  const idxItemName = h("item_name_raw");
  const idxItemNorm = h("item_name_normalized");
  const idxQtyOrd = h("quantity_ordered");
  const idxQty = h("quantity");
  const idxQtyRaw = h("quantity_raw");
  const idxUnit = h("unit");
  const idxPack = h("pack_size_raw");
  const idxWeight = h("approx_weight");
  const idxCat = h("category");
  const idxCost = h("unit_cost");
  const idxTotal = h("line_total");
  const idxConf = h("confidence");
  const idxFee = h("is_fee");
  const idxNotes = h("notes");
  const idxPhoto = h("photo_url");
  const idxChannel = h("slack_channel");
  const idxTs = h("slack_message_ts");
  const idxUploader = h("uploaded_by");
  const idxWarn = h("warnings_json");
  const idxDonor = h("donor_org");
  const idxDonation = h("is_donation");
  const idxAppAt = h("approved_at");
  const idxAppBy = h("approved_by");
  const idxDonorName = h("donor_name");
  const idxDonorEmail = h("donor_email");
  const idxDonorAnon = h("donor_anonymous");
  const idxSendReceipt = h("send_receipt");
  const idxFoodDrive = h("is_food_drive");
  const idxIsFood = h("is_food");
  const mapped: DeliverySheetRow[] = rows.map((r, i) => ({
    rowIndex: i + 2,
    created_at: r[idxCreated] ?? "",
    supplier: r[idxSupplier] ?? "",
    document_type: r[idxDocType] ?? "",
    invoice_date: r[idxInvoiceDate] ?? null,
    delivery_date: r[idxDelivery] ?? null,
    invoice_or_order_number: r[idxInv] ?? null,
    destination_org: r[idxDest] ?? null,
    item_code_raw: r[idxItemCode] ?? null,
    item_name_raw: r[idxItemName] ?? null,
    item_name_normalized: r[idxItemNorm] ?? null,
    quantity_ordered: r[idxQtyOrd] ?? null,
    quantity: r[idxQty] ?? null,
    quantity_raw: r[idxQtyRaw] ?? null,
    unit: r[idxUnit] ?? null,
    pack_size_raw: r[idxPack] ?? null,
    approx_weight: r[idxWeight] ?? null,
    category: r[idxCat] ?? null,
    unit_cost: r[idxCost] ?? null,
    line_total: r[idxTotal] ?? null,
    confidence: r[idxConf] ?? null,
    is_fee: r[idxFee] ?? null,
    notes: r[idxNotes] ?? null,
    photo_url: r[idxPhoto] ?? null,
    slack_channel: r[idxChannel] ?? null,
    slack_message_ts: r[idxTs] ?? null,
    uploaded_by: r[idxUploader] ?? null,
    warnings_json: r[idxWarn] ?? null,
    donor_org: r[idxDonor] ?? null,
    is_donation: r[idxDonation] ?? null,
    approved_at: r[idxAppAt] ?? null,
    approved_by: r[idxAppBy] ?? null,
    donor_name: r[idxDonorName] ?? null,
    donor_email: r[idxDonorEmail] ?? null,
    donor_anonymous: r[idxDonorAnon] ?? null,
    send_receipt: r[idxSendReceipt] ?? null,
    is_food_drive: r[idxFoodDrive] ?? null,
    is_food: r[idxIsFood] ?? null
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

// ── Prompt Suggestions ──────────────────────────────────────────────────────

export const PROMPT_SUGGESTIONS_HEADERS = [
  "created_at",
  "submitted_by",
  "supplier",
  "slip_photo_url",
  "suggestion_text",
  "status",
  "resolved_at",
  "resolved_by",
  "resolution_notes"
];

export async function ensurePromptSuggestionsHeader(): Promise<void> {
  await ensureHeader(env.PROMPT_SUGGESTIONS_WORKSHEET_NAME, PROMPT_SUGGESTIONS_HEADERS);
}

export async function appendPromptSuggestion(params: {
  submittedBy: string;
  supplier: string;
  slipPhotoUrl: string | null;
  suggestionText: string;
}): Promise<{ rowIndex: number; createdAt: string }> {
  await ensurePromptSuggestionsHeader();
  const createdAt = new Date().toISOString();
  const row = [
    createdAt,
    params.submittedBy,
    params.supplier,
    params.slipPhotoUrl ?? "",
    params.suggestionText,
    "pending",
    "",
    "",
    ""
  ];
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.PROMPT_SUGGESTIONS_WORKSHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
  // updatedRange looks like `'Prompt Suggestions'!A17:I17` — pull the row number.
  const updatedRange = res.data.updates?.updatedRange ?? "";
  const rowMatch = updatedRange.match(/!\D+(\d+):/);
  const rowIndex = rowMatch ? parseInt(rowMatch[1], 10) : -1;
  return { rowIndex, createdAt };
}

export async function readPromptSuggestions(params?: {
  status?: PromptSuggestionStatus;
  limit?: number;
}): Promise<PromptSuggestionRow[]> {
  await ensurePromptSuggestionsHeader();
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.PROMPT_SUGGESTIONS_WORKSHEET_NAME}!A2:I`
  });
  const rows = res.data.values ?? [];
  const parsed: PromptSuggestionRow[] = rows.map((r, i) => ({
    rowIndex: i + 2,
    created_at: r[0] ?? "",
    submitted_by: r[1] ?? "",
    supplier: r[2] ?? "",
    slip_photo_url: r[3] || null,
    suggestion_text: r[4] ?? "",
    status: (r[5] as PromptSuggestionStatus) || "pending",
    resolved_at: r[6] || null,
    resolved_by: r[7] || null,
    resolution_notes: r[8] || null
  }));
  const filtered = params?.status ? parsed.filter((s) => s.status === params.status) : parsed;
  const sorted = filtered.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return params?.limit ? sorted.slice(0, params.limit) : sorted;
}

export async function updatePromptSuggestionStatus(params: {
  rowIndex: number;
  status: PromptSuggestionStatus;
  resolvedBy: string;
  notes: string | null;
}): Promise<void> {
  const { rowIndex, status, resolvedBy, notes } = params;
  const statusCol = indexToColumn(PROMPT_SUGGESTIONS_HEADERS.indexOf("status"));
  const resolvedAtCol = indexToColumn(PROMPT_SUGGESTIONS_HEADERS.indexOf("resolved_at"));
  const resolvedByCol = indexToColumn(PROMPT_SUGGESTIONS_HEADERS.indexOf("resolved_by"));
  const notesCol = indexToColumn(PROMPT_SUGGESTIONS_HEADERS.indexOf("resolution_notes"));
  const now = new Date().toISOString();
  const sheets = google.sheets({ version: "v4", auth });
  const tab = env.PROMPT_SUGGESTIONS_WORKSHEET_NAME;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: `${tab}!${statusCol}${rowIndex}`, values: [[status]] },
        { range: `${tab}!${resolvedAtCol}${rowIndex}`, values: [[now]] },
        { range: `${tab}!${resolvedByCol}${rowIndex}`, values: [[resolvedBy]] },
        { range: `${tab}!${notesCol}${rowIndex}`, values: [[notes ?? ""]] }
      ]
    }
  });
}

export interface CorrectionEntry {
  user: string;
  slipKey: string;
  sheet: string;
  rowIndex: number;
  field: string;
  oldValue: string | number | boolean | null;
  newValue: string | number | boolean | null;
  reason: string | null;
}

export async function appendCorrectionRow(entry: CorrectionEntry): Promise<void> {
  await appendCorrectionRows([entry]);
}

// Batched corrections append — one Sheets API write for N entries. Keeps
// slip-level edits under the write-per-minute quota.
export async function appendCorrectionRows(entries: CorrectionEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await ensureCorrectionsLogHeader();
  const now = new Date().toISOString();
  const values = entries.map((e) => [
    now,
    e.user,
    e.slipKey,
    e.sheet,
    e.rowIndex,
    e.field,
    e.oldValue == null ? "" : String(e.oldValue),
    e.newValue == null ? "" : String(e.newValue),
    e.reason ?? ""
  ]);
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.CORRECTIONS_LOG_WORKSHEET_NAME}!A:I`,
    valueInputOption: "RAW",
    requestBody: { values }
  });
}

// ── Slip-level helpers (a "slip" = all inbound rows sharing one photo_url) ───

export interface SlipSummary {
  slipKey: string; // photo_url
  supplier: string;
  document_type: string;
  invoice_date: string | null;
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
  totalPounds: number | null;
  approved: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
  uploaded_by: string | null;
  flaggedForReview: boolean;
}

export function rescueDedupeKey(supplier: string | null, donorOrg: string | null, deliveryDate: string | null): string | null {
  if (!supplier || !donorOrg || !deliveryDate) return null;
  // Accept both the new supplier slug and the legacy value so historical rows
  // still contribute to the in-memory dedupe set until the backfill lands.
  if (supplier !== "grocery_rescue" && supplier !== "food_lifeline") return null;
  const donor = donorOrg.trim().toLowerCase().replace(/\s+/g, " ");
  if (!donor) return null;
  return `grocery_rescue:${donor}:${deliveryDate}`;
}

export async function readRescueDedupeKeys(): Promise<Set<string>> {
  const rows = await readDeliveryRows({ limit: 100000 });
  const keys = new Set<string>();
  for (const r of rows) {
    const k = rescueDedupeKey(r.supplier, r.donor_org, r.delivery_date);
    if (k) keys.add(k);
  }
  return keys;
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
    let flaggedForReview = false;
    let totalPounds: number | null = null;
    for (const r of group) {
      const c = r.confidence ? parseFloat(r.confidence) : NaN;
      if (Number.isFinite(c)) {
        if (minConf === null || c < minConf) minConf = c;
      }
      const w = r.approx_weight ? parseFloat(r.approx_weight) : NaN;
      if (Number.isFinite(w)) totalPounds = (totalPounds ?? 0) + w;
      if (!r.approved_at) {
        allApproved = false;
      } else {
        approvedAt = r.approved_at;
        approvedBy = r.approved_by;
      }
      if (r.warnings_json && r.warnings_json.includes("possible duplicate")) {
        flaggedForReview = true;
      }
    }
    summaries.push({
      slipKey: key,
      supplier: first.supplier,
      document_type: first.document_type,
      invoice_date: first.invoice_date,
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
      totalPounds,
      approved: allApproved && group.length > 0,
      approvedAt,
      approvedBy,
      uploaded_by: first.uploaded_by,
      flaggedForReview
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
      valueInputOption: "RAW",
      data: rowIndexes.flatMap((rowIndex) => [
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedAtCol}${rowIndex}`, values: [[now]] },
        { range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedByCol}${rowIndex}`, values: [[approvedBy]] }
      ])
    }
  });
}

export interface EodSlipSummary {
  slipKey: string; // "<channel>:<messageTs>"
  slackChannel: string;
  slackMessageTs: string;
  source: string; // whiteboard | text | voice
  date: string | null;
  program_type: string | null;
  recorded_by: string | null;
  recorded_at: string;
  photo_url: string | null;
  rowCount: number;
  rowIndexes: number[];
  minConfidence: number | null;
  approved: boolean;
  approvedAt: string | null;
  approvedBy: string | null;
}

export function eodSlipKey(row: EodSheetRow): string | null {
  if (!row.slack_channel || !row.slack_message_ts) return null;
  return `${row.slack_channel}:${row.slack_message_ts}`;
}

export function groupEodSlips(rows: EodSheetRow[]): EodSlipSummary[] {
  const byKey = new Map<string, EodSheetRow[]>();
  for (const r of rows) {
    const key = eodSlipKey(r);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(r);
  }
  const summaries: EodSlipSummary[] = [];
  for (const [key, group] of byKey) {
    const first = group[0];
    let minConf: number | null = null;
    let allApproved = true;
    let approvedAt: string | null = null;
    let approvedBy: string | null = null;
    let photoUrl: string | null = null;
    let programType: string | null = null;
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
      if (!photoUrl && r.photo_url) photoUrl = r.photo_url;
      if (!programType && r.program_type) programType = r.program_type;
    }
    summaries.push({
      slipKey: key,
      slackChannel: first.slack_channel ?? "",
      slackMessageTs: first.slack_message_ts ?? "",
      source: first.source ?? "unknown",
      date: first.date || null,
      program_type: programType,
      recorded_by: first.recorded_by,
      recorded_at: first.recorded_at,
      photo_url: photoUrl,
      rowCount: group.length,
      rowIndexes: group.map((r) => r.rowIndex),
      minConfidence: minConf,
      approved: allApproved && group.length > 0,
      approvedAt,
      approvedBy
    });
  }
  summaries.sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? ""));
  return summaries;
}

export async function stampEodApproval(params: {
  rowIndexes: number[];
  approvedBy: string;
}): Promise<void> {
  const { rowIndexes, approvedBy } = params;
  const approvedAtCol = indexToColumn(EOD_SHEET_HEADERS.indexOf("approved_at"));
  const approvedByCol = indexToColumn(EOD_SHEET_HEADERS.indexOf("approved_by"));
  const now = new Date().toISOString();
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: rowIndexes.flatMap((rowIndex) => [
        { range: `${env.EOD_WORKSHEET_NAME}!${approvedAtCol}${rowIndex}`, values: [[now]] },
        { range: `${env.EOD_WORKSHEET_NAME}!${approvedByCol}${rowIndex}`, values: [[approvedBy]] }
      ])
    }
  });
}

export async function clearEodApproval(rowIndexes: number[]): Promise<void> {
  const approvedAtCol = indexToColumn(EOD_SHEET_HEADERS.indexOf("approved_at"));
  const approvedByCol = indexToColumn(EOD_SHEET_HEADERS.indexOf("approved_by"));
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "RAW",
      data: rowIndexes.flatMap((rowIndex) => [
        { range: `${env.EOD_WORKSHEET_NAME}!${approvedAtCol}${rowIndex}`, values: [[""]] },
        { range: `${env.EOD_WORKSHEET_NAME}!${approvedByCol}${rowIndex}`, values: [[""]] }
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
      valueInputOption: "RAW",
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
    invoice_date: first.invoice_date,
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
  const lastSumCol = indexToColumnLetter(SUMMARY_SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:${lastSumCol}`
  });
  const allRows = res.data.values ?? [];
  const sSupIdx = SUMMARY_SHEET_HEADERS.indexOf("supplier");
  const sInvIdx = SUMMARY_SHEET_HEADERS.indexOf("invoice_or_order_number");
  const sPhotoIdx = SUMMARY_SHEET_HEADERS.indexOf("photo_url");
  let matchRowIndex = -1;
  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    const rSupplier = row[sSupIdx] ?? "";
    const rInvoice = row[sInvIdx] ?? "";
    const rPhoto = row[sPhotoIdx] ?? "";
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
    extraction.invoice_date,
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
    range: `${env.SUMMARY_WORKSHEET_NAME}!A${matchRowIndex}:${lastSumCol}${matchRowIndex}`,
    valueInputOption: "RAW",
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
  await updateSheetCells({ worksheetName: params.worksheetName, updates: [{
    rowIndex: params.rowIndex,
    columnName: params.columnName,
    newValue: params.newValue
  }]});
}

// Batched single-cell update — one Sheets API write for N cells on the same
// worksheet. Prevents "Write requests per minute per user" quota errors when a
// slip-level edit fans out across many rows.
export async function updateSheetCells(params: {
  worksheetName: string;
  updates: Array<{ rowIndex: number; columnName: string; newValue: string | number | boolean | null }>;
}): Promise<void> {
  const { worksheetName, updates } = params;
  if (updates.length === 0) return;
  const headers = worksheetName === env.EOD_WORKSHEET_NAME ? EOD_SHEET_HEADERS : SHEET_HEADERS;
  const data = updates.map(({ rowIndex, columnName, newValue }) => {
    const colIndex = headers.indexOf(columnName);
    if (colIndex === -1) throw new Error(`Unknown column: ${columnName}`);
    const colLetter = indexToColumn(colIndex);
    return {
      range: `${worksheetName}!${colLetter}${rowIndex}`,
      values: [[coerceForColumn(columnName, newValue)]]
    };
  });
  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data }
  });
}
