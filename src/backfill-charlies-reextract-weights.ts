/**
 * One-off: re-extract historical Charlie's slips to fill approx_weight cells
 * that the old prompt left blank. The APPROX.WT column on Charlie's invoices
 * is per-case (not per-line, which the pre-PR-#79 prompt asserted). Slips
 * with count-only packs (e.g. `1 40/60CT`) never got a weight via the
 * pack-fallback backfill and can only be recovered by re-extraction.
 *
 * Scope: Slack-hosted photos only. `loadslip.upload/<hash>` URLs are in-memory
 * with 24h TTL and cannot be re-fetched — those are reported and skipped.
 *
 * Safety:
 * - Default is dry-run. `--apply` writes.
 * - Only overwrites cells whose current approx_weight is null; never touches
 *   a non-null value (protects human corrections + prior legit extractions).
 * - `--limit=N` caps the number of slips processed per invocation so a bad
 *   run doesn't burn budget or corrupt many rows before you catch it.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-charlies-reextract-weights.ts [--apply] [--limit=N]
 */
import axios from "axios";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { extractFromImage } from "./extraction.js";
import { SHEET_HEADERS, SUMMARY_SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function parseArgs(): { apply: boolean; limit: number } {
  const args = process.argv.slice(2);
  let apply = false;
  let limit = 5;
  for (const a of args) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--limit=")) limit = parseInt(a.slice("--limit=".length), 10);
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive integer (got ${limit})`);
  }
  return { apply, limit };
}

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

function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

async function downloadSlackFile(url: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }
  });
  return Buffer.from(res.data);
}

interface CandidateRow {
  rowNumber: number;
  photoUrl: string;
  invoice: string;
  itemCode: string;
  itemName: string;
  filename: string;
}

interface PlannedUpdate {
  photoUrl: string;
  rowNumber: number;
  invoice: string;
  itemCode: string;
  itemName: string;
  newWeight: number;
  matchedBy: "code" | "name";
}

interface SkippedSlip {
  photoUrl: string;
  reason: "loadslip_upload_expired" | "download_failed" | "extract_failed" | "no_matches";
  detail?: string;
  candidateCount: number;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();

  const logRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const rows = logRes.data.values ?? [];
  const headerToIdx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supIdx = headerToIdx.get("supplier")!;
  const invIdx = headerToIdx.get("invoice_or_order_number")!;
  const codeIdx = headerToIdx.get("item_code_raw")!;
  const nameIdx = headerToIdx.get("item_name_raw")!;
  const weightIdx = headerToIdx.get("approx_weight")!;
  const isFeeIdx = headerToIdx.get("is_fee")!;
  const photoIdx = headerToIdx.get("photo_url")!;
  const filenameIdx = headerToIdx.get("filename")!;

  const candidatesByPhoto = new Map<string, CandidateRow[]>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if ((r[supIdx] ?? "") !== "charlies") continue;
    if ((r[isFeeIdx] ?? "").toString().toUpperCase() === "TRUE") continue;
    const w = (r[weightIdx] ?? "").toString().trim();
    if (w !== "") continue; // skip rows that already have a weight
    const photoUrl = (r[photoIdx] ?? "").toString();
    if (!photoUrl) continue;
    const c: CandidateRow = {
      rowNumber: i + 1,
      photoUrl,
      invoice: (r[invIdx] ?? "").toString(),
      itemCode: (r[codeIdx] ?? "").toString(),
      itemName: (r[nameIdx] ?? "").toString(),
      filename: (r[filenameIdx] ?? "").toString() || filenameFromUrl(photoUrl)
    };
    const bucket = candidatesByPhoto.get(photoUrl) ?? [];
    bucket.push(c);
    candidatesByPhoto.set(photoUrl, bucket);
  }

  const totalCandidateRows = Array.from(candidatesByPhoto.values()).reduce((s, b) => s + b.length, 0);
  const slackSlips: string[] = [];
  const loadslipExpiredSlips: string[] = [];
  for (const photoUrl of candidatesByPhoto.keys()) {
    if (photoUrl.startsWith("https://loadslip.upload/")) loadslipExpiredSlips.push(photoUrl);
    else slackSlips.push(photoUrl);
  }

  console.log(`Charlies rows with null approx_weight: ${totalCandidateRows} across ${candidatesByPhoto.size} slips`);
  console.log(`  Slack-hosted (recoverable): ${slackSlips.length}`);
  console.log(`  loadslip.upload (24h TTL, unrecoverable): ${loadslipExpiredSlips.length}`);
  console.log(`Plan: process up to ${limit} Slack slip(s) this run. Mode: ${apply ? "APPLY (writes)" : "DRY-RUN (no writes)"}`);

  const targets = slackSlips.slice(0, limit);
  const plannedUpdates: PlannedUpdate[] = [];
  const skipped: SkippedSlip[] = [];

  for (const photoUrl of targets) {
    const bucket = candidatesByPhoto.get(photoUrl)!;
    const sampleFilename = bucket[0].filename;
    console.log(`\n▶ ${sampleFilename}  (${bucket.length} rows to fill, invoice=${bucket[0].invoice})`);

    let bytes: Buffer;
    try {
      bytes = await downloadSlackFile(photoUrl);
    } catch (err) {
      console.log(`  ! download failed: ${(err as Error).message}`);
      skipped.push({ photoUrl, reason: "download_failed", detail: (err as Error).message, candidateCount: bucket.length });
      continue;
    }

    const mimeType = mimeForFilename(sampleFilename);
    let extraction;
    try {
      const out = await extractFromImage({ imageBytes: bytes, mimeType, filename: sampleFilename, supplierHint: "charlies" });
      extraction = out.result;
    } catch (err) {
      console.log(`  ! extract failed: ${(err as Error).message}`);
      skipped.push({ photoUrl, reason: "extract_failed", detail: (err as Error).message, candidateCount: bucket.length });
      continue;
    }

    if (extraction.supplier !== "charlies") {
      console.log(`  ! re-extraction says supplier=${extraction.supplier}, expected charlies — skipping`);
      skipped.push({ photoUrl, reason: "extract_failed", detail: `supplier=${extraction.supplier}`, candidateCount: bucket.length });
      continue;
    }

    const invoice = extraction.invoice_or_order_number ?? "";
    console.log(`  extracted invoice=${invoice} items=${extraction.line_items.length}`);

    let matchCount = 0;
    for (const item of extraction.line_items) {
      if (item.is_fee) continue;
      if (typeof item.approx_weight !== "number" || !Number.isFinite(item.approx_weight)) continue;

      let matched: CandidateRow | undefined;
      let matchedBy: "code" | "name" = "code";
      if (item.item_code_raw) {
        matched = bucket.find((c) => normalizeCode(c.itemCode) === normalizeCode(item.item_code_raw!));
      }
      if (!matched && item.item_name_raw) {
        matched = bucket.find((c) => c.itemName === item.item_name_raw);
        if (matched) matchedBy = "name";
      }
      if (!matched) continue;

      plannedUpdates.push({
        photoUrl,
        rowNumber: matched.rowNumber,
        invoice,
        itemCode: matched.itemCode,
        itemName: matched.itemName,
        newWeight: item.approx_weight,
        matchedBy
      });
      matchCount++;
    }

    console.log(`  planned ${matchCount}/${bucket.length} weight fills`);
    if (matchCount === 0) {
      skipped.push({ photoUrl, reason: "no_matches", candidateCount: bucket.length });
    }
  }

  // ── Write CSV to Desktop for review ──────────────────────────────────────
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const csvPath = join(homedir(), "Desktop", `charlies-reextract-plan-${stamp}.csv`);
  const csvLines: string[] = ["row_number,invoice,item_code_raw,item_name_raw,matched_by,new_weight,photo_url"];
  for (const u of plannedUpdates) {
    csvLines.push([u.rowNumber, u.invoice, u.itemCode, u.itemName, u.matchedBy, u.newWeight, u.photoUrl].map(csvField).join(","));
  }
  writeFileSync(csvPath, csvLines.join("\n") + "\n");
  console.log(`\nPlan CSV: ${csvPath}`);

  console.log(`\nSummary:`);
  console.log(`  slips processed:     ${targets.length}`);
  console.log(`  planned cell fills:  ${plannedUpdates.length}`);
  console.log(`  skipped slips:       ${skipped.length}`);
  for (const s of skipped) {
    console.log(`    - ${s.reason}${s.detail ? ` (${s.detail})` : ""}: ${s.photoUrl} [${s.candidateCount} rows]`);
  }

  if (!apply) {
    console.log(`\nDry-run only. Re-run with --apply to write.`);
    return;
  }

  if (plannedUpdates.length === 0) {
    console.log(`\nNothing to write.`);
    return;
  }

  const weightColA1 = indexToA1(weightIdx);
  const cellUpdates: sheets_v4.Schema$ValueRange[] = plannedUpdates.map((u) => ({
    range: `${env.GOOGLE_WORKSHEET_NAME}!${weightColA1}${u.rowNumber}`,
    values: [[u.newWeight]]
  }));
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: cellUpdates }
  });
  console.log(`\nWrote ${cellUpdates.length} approx_weight cell(s).`);

  // ── Recompute Inventory Summary weight_lb per touched slip ───────────────
  const touchedInvoices = new Set(plannedUpdates.map((u) => normalizeInvoice(u.invoice)));
  const summaryRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:Z`
  });
  const summaryRows = summaryRes.data.values ?? [];
  const sHeader = new Map(SUMMARY_SHEET_HEADERS.map((h, i) => [h, i]));
  const sSup = sHeader.get("supplier")!;
  const sInv = sHeader.get("invoice_or_order_number")!;
  const sW = sHeader.get("weight_lb")!;
  const sWColA1 = indexToA1(sW);

  // Re-read the Delivery Log after cell updates so the recompute reads fresh
  // weights (batchUpdate does not update our local `rows` in place).
  const freshLogRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const freshRows = freshLogRes.data.values ?? [];

  const summaryUpdates: sheets_v4.Schema$ValueRange[] = [];
  for (const invNorm of touchedInvoices) {
    let sumRowNumber: number | null = null;
    for (let i = 1; i < summaryRows.length; i++) {
      if ((summaryRows[i][sSup] ?? "") === "charlies" && normalizeInvoice(summaryRows[i][sInv]) === invNorm) {
        sumRowNumber = i + 1;
        break;
      }
    }
    if (sumRowNumber == null) continue;

    let total = 0;
    for (let i = 1; i < freshRows.length; i++) {
      const r = freshRows[i];
      if ((r[supIdx] ?? "") !== "charlies") continue;
      if (normalizeInvoice(r[invIdx]) !== invNorm) continue;
      if ((r[isFeeIdx] ?? "").toString().toUpperCase() === "TRUE") continue;
      const w = parseFloat((r[weightIdx] ?? "").toString());
      if (Number.isFinite(w)) total += w;
    }
    const newWeight = total > 0 ? Number(total.toFixed(2)) : null;
    summaryUpdates.push({
      range: `${env.SUMMARY_WORKSHEET_NAME}!${sWColA1}${sumRowNumber}`,
      values: [[newWeight]]
    });
  }
  if (summaryUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: summaryUpdates }
    });
    console.log(`Recomputed weight_lb on ${summaryUpdates.length} Inventory Summary row(s).`);
  }
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
