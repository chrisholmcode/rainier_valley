/**
 * One-off: retroactively auto-approve historical slips in the Inbound Delivery
 * Log whose min line-item confidence meets REVIEW_CONFIDENCE_THRESHOLD.
 *
 * Only touches rows where approved_at is empty — never overwrites a prior
 * (human or auto) approval. Fee rows are stamped alongside their siblings
 * even though they have no confidence themselves.
 *
 * Usage:
 *   npx tsx src/backfill-auto-approve.ts [--apply]
 *
 *   Without --apply, prints a dry-run summary. With --apply, writes.
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS } from "./sheets.js";

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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const threshold = env.REVIEW_CONFIDENCE_THRESHOLD;
  console.log(`Backfill auto-approve using REVIEW_CONFIDENCE_THRESHOLD=${threshold} (${apply ? "APPLY" : "dry-run"})`);

  const lastCol = indexToA1(SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastCol}`
  });
  const rows = res.data.values ?? [];
  const idx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const photoIdx = idx.get("photo_url")!;
  const confIdx = idx.get("confidence")!;
  const isFeeIdx = idx.get("is_fee")!;
  const approvedAtIdx = idx.get("approved_at")!;
  const supplierIdx = idx.get("supplier")!;
  const invoiceIdx = idx.get("invoice_or_order_number")!;

  // Group by photo_url; track row numbers, confidences, and existing approvals.
  interface Group {
    photoUrl: string;
    supplier: string;
    invoice: string;
    rowNumbers: number[];
    unapprovedRowNumbers: number[];
    minConfidence: number | null;
    anyApproved: boolean;
  }
  const groups = new Map<string, Group>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const photo = String(r[photoIdx] ?? "");
    if (!photo) continue;
    let g = groups.get(photo);
    if (!g) {
      g = {
        photoUrl: photo,
        supplier: String(r[supplierIdx] ?? ""),
        invoice: String(r[invoiceIdx] ?? ""),
        rowNumbers: [],
        unapprovedRowNumbers: [],
        minConfidence: null,
        anyApproved: false
      };
      groups.set(photo, g);
    }
    g.rowNumbers.push(i + 1);
    const isFee = String(r[isFeeIdx] ?? "").toUpperCase() === "TRUE";
    if (!isFee) {
      const c = Number(r[confIdx]);
      if (Number.isFinite(c)) {
        g.minConfidence = g.minConfidence === null ? c : Math.min(g.minConfidence, c);
      }
    }
    if (String(r[approvedAtIdx] ?? "").trim()) {
      g.anyApproved = true;
    } else {
      g.unapprovedRowNumbers.push(i + 1);
    }
  }

  interface Plan {
    photoUrl: string;
    supplier: string;
    invoice: string;
    minConfidence: number;
    rowsToStamp: number[];
  }
  const plans: Plan[] = [];
  let skippedNoConf = 0;
  let skippedBelowThreshold = 0;
  let skippedFullyApproved = 0;
  for (const g of groups.values()) {
    if (g.minConfidence === null) { skippedNoConf++; continue; }
    if (g.minConfidence < threshold) { skippedBelowThreshold++; continue; }
    if (g.unapprovedRowNumbers.length === 0) { skippedFullyApproved++; continue; }
    plans.push({
      photoUrl: g.photoUrl,
      supplier: g.supplier,
      invoice: g.invoice,
      minConfidence: g.minConfidence,
      rowsToStamp: g.unapprovedRowNumbers
    });
  }

  const totalCells = plans.reduce((a, p) => a + p.rowsToStamp.length * 2, 0);
  console.log(
    `\nSlips: total=${groups.size}  no-confidence=${skippedNoConf}  below-threshold=${skippedBelowThreshold}  already-approved=${skippedFullyApproved}  to-approve=${plans.length}`
  );
  console.log(`Rows to stamp: ${plans.reduce((a, p) => a + p.rowsToStamp.length, 0)} (${totalCells} cell writes)`);
  for (const p of plans.slice(0, 40)) {
    console.log(`  ${p.supplier}/${p.invoice || "?"}  minConf=${p.minConfidence.toFixed(2)}  rows=${p.rowsToStamp.length}`);
  }
  if (plans.length > 40) console.log(`  … +${plans.length - 40} more`);

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const approvedAtCol = indexToA1(approvedAtIdx);
  const approvedByCol = indexToA1(idx.get("approved_by")!);
  const now = new Date().toISOString();
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const p of plans) {
    for (const rowNumber of p.rowsToStamp) {
      updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedAtCol}${rowNumber}`, values: [[now]] });
      updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${approvedByCol}${rowNumber}`, values: [["auto-approved"]] });
    }
  }
  // Batch in chunks to stay under any per-request payload limits.
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "USER_ENTERED", data: chunk }
    });
    console.log(`  wrote ${Math.min(i + CHUNK, updates.length)}/${updates.length} cell updates`);
  }
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("backfill-auto-approve failed:", err);
  process.exit(1);
});
