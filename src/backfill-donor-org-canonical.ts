/**
 * One-off: normalize donor_org on historical grocery_rescue rows to one of
 * the 5 canonical short codes (QFC-MI / QFC-BWY / SWY-RB / SWY-GEN /
 * HG). Pre-normalization variants (e.g. "Safeway-Gen", "MI-QFC",
 * "QFC Brdwy", "Homegrown") pre-date the ingest-time normalizer and
 * still linger on older rows.
 *
 * Also re-synthesizes invoice_or_order_number = <donor>-<delivery_date>
 * for any row it touches, since that shipment ID is derived from donor_org.
 *
 * Idempotent: skips rows whose donor_org is already canonical. Reruns
 * after apply are no-ops.
 *
 * Usage:
 *   npx tsx src/backfill-donor-org-canonical.ts [--apply]
 *
 * The local .env points at the legacy "Delivery Log" tab; run against
 * production with GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" prefixed.
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS } from "./sheets.js";
import { normalizeRescueDonor, RESCUE_DONOR_CANONICAL } from "./extraction.js";

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
  console.log(`Backfill donor_org canonical (${apply ? "APPLY" : "dry-run"})`);

  const lastCol = indexToA1(SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastCol}`
  });
  const rows = res.data.values ?? [];
  const idx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supplierIdx = idx.get("supplier")!;
  const donorIdx = idx.get("donor_org")!;
  const dateIdx = idx.get("delivery_date")!;
  const invoiceIdx = idx.get("invoice_or_order_number")!;
  const canonical = new Set<string>(RESCUE_DONOR_CANONICAL);

  interface Plan {
    rowNumber: number;
    fromDonor: string;
    toDonor: string;
    date: string;
    oldInvoice: string;
    newInvoice: string;
  }
  const plans: Plan[] = [];
  const unresolved: { rowNumber: number; donor: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[supplierIdx] ?? "") !== "grocery_rescue") continue;
    const donor = String(r[donorIdx] ?? "").trim();
    if (!donor) continue;
    if (canonical.has(donor)) continue;
    const mapped = normalizeRescueDonor(donor);
    if (!mapped) {
      unresolved.push({ rowNumber: i + 1, donor });
      continue;
    }
    const date = String(r[dateIdx] ?? "").trim();
    const oldInvoice = String(r[invoiceIdx] ?? "").trim();
    const newInvoice = date ? `${mapped}-${date}` : oldInvoice;
    plans.push({ rowNumber: i + 1, fromDonor: donor, toDonor: mapped, date, oldInvoice, newInvoice });
  }

  const byPair = new Map<string, number>();
  for (const p of plans) {
    const k = `${p.fromDonor} → ${p.toDonor}`;
    byPair.set(k, (byPair.get(k) ?? 0) + 1);
  }
  console.log(`\nRows to normalize: ${plans.length}`);
  for (const [pair, n] of [...byPair.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pair.padEnd(28)}  ${n}`);
  }
  if (unresolved.length) {
    console.log(`\nUnresolved (${unresolved.length}) — donor_org unrecognized, will not be touched:`);
    for (const u of unresolved.slice(0, 20)) {
      console.log(`  row ${u.rowNumber}  donor="${u.donor}"`);
    }
    if (unresolved.length > 20) console.log(`  … +${unresolved.length - 20} more`);
  }

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const donorCol = indexToA1(donorIdx);
  const invoiceCol = indexToA1(invoiceIdx);
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const p of plans) {
    updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${donorCol}${p.rowNumber}`, values: [[p.toDonor]] });
    if (p.newInvoice !== p.oldInvoice) {
      updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${invoiceCol}${p.rowNumber}`, values: [[p.newInvoice]] });
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: chunk }
    });
    console.log(`  wrote ${Math.min(i + CHUNK, updates.length)}/${updates.length} cell updates`);
  }
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("backfill-donor-org-canonical failed:", err);
  process.exit(1);
});
