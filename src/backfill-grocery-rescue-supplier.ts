/**
 * One-off: flip historical Inbound Delivery Log rows where
 * `supplier = "food_lifeline"` AND `donor_org` is non-empty over to
 * `supplier = "grocery_rescue"`. Those rows are the grocery-rescue subtype
 * (per the pre-split convention: food_lifeline + donor_org = rescue).
 * PR #44 introduced grocery_rescue as its own supplier; this script
 * migrates the historical data so the two subtypes stop sharing a slug.
 *
 * Runtime predicates in sheets.ts / index.ts / review.ts continue to accept
 * both values until this runs, so there's no urgency, but for data
 * consistency (dashboards, exports, prompt-tuner clustering) we want the
 * split to be clean.
 *
 * Idempotent: only touches rows with the exact legacy shape. Reruns after
 * apply are no-ops.
 *
 * Usage:
 *   npx tsx src/backfill-grocery-rescue-supplier.ts [--apply]
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
  console.log(`Backfill grocery_rescue supplier (${apply ? "APPLY" : "dry-run"})`);

  const lastCol = indexToA1(SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastCol}`
  });
  const rows = res.data.values ?? [];
  const idx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supplierIdx = idx.get("supplier")!;
  const donorIdx = idx.get("donor_org")!;

  interface Plan {
    rowNumber: number;
    donor: string;
  }
  const plans: Plan[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[supplierIdx] ?? "") !== "food_lifeline") continue;
    const donor = String(r[donorIdx] ?? "").trim();
    if (!donor) continue;
    plans.push({ rowNumber: i + 1, donor });
  }

  const byDonor = new Map<string, number>();
  for (const p of plans) byDonor.set(p.donor, (byDonor.get(p.donor) ?? 0) + 1);
  console.log(`\nRows to flip: ${plans.length}`);
  for (const [donor, n] of [...byDonor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${donor.padEnd(12)}  ${n}`);
  }

  if (plans.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const supplierCol = indexToA1(supplierIdx);
  const updates: sheets_v4.Schema$ValueRange[] = plans.map((p) => ({
    range: `${env.GOOGLE_WORKSHEET_NAME}!${supplierCol}${p.rowNumber}`,
    values: [["grocery_rescue"]]
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
  console.error("backfill-grocery-rescue-supplier failed:", err);
  process.exit(1);
});
