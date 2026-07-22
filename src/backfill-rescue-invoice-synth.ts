/**
 * One-off: synthesize invoice_or_order_number for historical grocery_rescue
 * rows whose donor_org + delivery_date are set but the shipment ID never
 * got written. Symptom: opening one of these slips in the Review UI shows
 * an empty INVOICE_OR_ORDER_NUMBER field despite having a valid donor and
 * delivery date.
 *
 * How the null gets there: extract-time synthesizer only ran when both
 * donor_org and delivery_date came back from the LLM in the same call.
 * PR #42's reviewer-edit cascade only fires when donor_org or
 * delivery_date is *edited* (old !== new). Rows where a reviewer set
 * either field for the first time without touching the other never
 * cascaded, so invoice_or_order_number stayed null.
 *
 * Writes: invoice_or_order_number = `<donor_org>-<delivery_date>` on
 * any grocery_rescue row missing it. Idempotent — rows already carrying
 * the correct synth are skipped. Rows with non-canonical donor_org are
 * skipped and reported (should be zero after PR #47's canonical backfill).
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx src/backfill-rescue-invoice-synth.ts [--apply]
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS } from "./sheets.js";
import { RESCUE_DONOR_CANONICAL } from "./extraction.js";

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
  console.log(`Backfill rescue invoice_or_order_number (${apply ? "APPLY" : "dry-run"})`);

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
    synth: string;
  }
  const plans: Plan[] = [];
  const skippedNonCanonical: { rowNumber: number; donor: string }[] = [];
  const skippedMissingDate: { rowNumber: number; donor: string }[] = [];
  let alreadySynthed = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[supplierIdx] ?? "") !== "grocery_rescue") continue;
    const donor = String(r[donorIdx] ?? "").trim();
    if (!donor) continue;
    const date = String(r[dateIdx] ?? "").trim();
    const invoice = String(r[invoiceIdx] ?? "").trim();
    const rowNumber = i + 1;
    if (!canonical.has(donor)) {
      skippedNonCanonical.push({ rowNumber, donor });
      continue;
    }
    if (!date) {
      skippedMissingDate.push({ rowNumber, donor });
      continue;
    }
    const synth = `${donor}-${date}`;
    if (invoice === synth) { alreadySynthed++; continue; }
    if (invoice) continue; // has a value that isn't the synth — don't overwrite
    plans.push({ rowNumber, synth });
  }

  const byDonor = new Map<string, number>();
  for (const p of plans) {
    const donor = p.synth.split("-")[0];
    byDonor.set(donor, (byDonor.get(donor) ?? 0) + 1);
  }
  console.log(`\nRows to fill: ${plans.length}`);
  for (const [donor, n] of [...byDonor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${donor.padEnd(10)}  ${n}`);
  }
  console.log(`\nAlready-synthed rows: ${alreadySynthed}`);
  if (skippedNonCanonical.length) {
    console.log(`Skipped (non-canonical donor, ${skippedNonCanonical.length}):`);
    for (const s of skippedNonCanonical.slice(0, 10)) console.log(`  row ${s.rowNumber}  donor="${s.donor}"`);
    if (skippedNonCanonical.length > 10) console.log(`  … +${skippedNonCanonical.length - 10} more`);
  }
  if (skippedMissingDate.length) {
    console.log(`Skipped (missing delivery_date, ${skippedMissingDate.length}):`);
    for (const s of skippedMissingDate.slice(0, 10)) console.log(`  row ${s.rowNumber}  donor="${s.donor}"`);
    if (skippedMissingDate.length > 10) console.log(`  … +${skippedMissingDate.length - 10} more`);
  }

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const invoiceCol = indexToA1(invoiceIdx);
  const updates: sheets_v4.Schema$ValueRange[] = plans.map((p) => ({
    range: `${env.GOOGLE_WORKSHEET_NAME}!${invoiceCol}${p.rowNumber}`,
    values: [[p.synth]]
  }));
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
  console.error("backfill-rescue-invoice-synth failed:", err);
  process.exit(1);
});
