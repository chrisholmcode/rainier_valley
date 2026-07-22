/**
 * One-off backfill: populate the is_donation column on the Inbound Delivery
 * Log for every row that's currently empty. Donation status is derived from
 * the supplier (and, for grand_central, from the destination_org suffix).
 *
 * Idempotent — only writes cells that are blank now; human edits are never
 * overwritten.
 *
 * Usage:
 *   npm run build && node dist/backfill-is-donation.js          # apply
 *   npm run build && node dist/backfill-is-donation.js --dry    # print plan only
 */
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const DONATION_SUPPLIERS = new Set<string>(["nw_harvest", "food_lifeline", "grocery_rescue"]);
const PURCHASED_SUPPLIERS = new Set<string>(["carusos", "charlies", "costco", "pacific", "terrebonne", "weigelt"]);

function deriveIsDonation(supplier: string, destinationOrg: string | null): boolean | null {
  const s = supplier?.toLowerCase().trim() ?? "";
  if (DONATION_SUPPLIERS.has(s)) return true;
  if (PURCHASED_SUPPLIERS.has(s)) return false;
  if (s === "grand_central") {
    const dest = (destinationOrg ?? "").toLowerCase();
    if (dest.includes("donation")) return true;
    if (dest.includes("purchased") || dest.includes("purchase")) return false;
    return false;
  }
  return null;
}

function indexToColumn(index: number): string {
  let col = "";
  let n = index;
  do {
    col = String.fromCharCode(65 + (n % 26)) + col;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return col;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const colIndex = SHEET_HEADERS.indexOf("is_donation");
  if (colIndex === -1) throw new Error("is_donation column not in SHEET_HEADERS");
  const colLetter = indexToColumn(colIndex);

  console.log(`Reading Inbound Delivery Log…`);
  const rows = await readDeliveryRows({ limit: 100000 });
  console.log(`  ${rows.length} rows read.`);

  const data: Array<{ range: string; values: string[][] }> = [];
  const summary = new Map<string, { rows: number; trueCount: number; falseCount: number; skip: number }>();
  let alreadySet = 0;
  let skippedUnknown = 0;

  for (const r of rows) {
    if (r.is_donation && r.is_donation.trim() !== "") {
      alreadySet++;
      continue;
    }
    const value = deriveIsDonation(r.supplier ?? "", r.destination_org);
    const sup = (r.supplier || "(blank)").toLowerCase();
    const bucket = summary.get(sup) ?? { rows: 0, trueCount: 0, falseCount: 0, skip: 0 };
    bucket.rows++;
    if (value === null) {
      bucket.skip++;
      skippedUnknown++;
    } else if (value === true) {
      bucket.trueCount++;
    } else {
      bucket.falseCount++;
    }
    summary.set(sup, bucket);

    if (value !== null) {
      data.push({
        range: `${env.GOOGLE_WORKSHEET_NAME}!${colLetter}${r.rowIndex}`,
        values: [[String(value)]]
      });
    }
  }

  console.log(`\nPer-supplier plan:`);
  for (const [sup, b] of Array.from(summary.entries()).sort()) {
    console.log(`  ${sup.padEnd(16)} rows=${String(b.rows).padStart(5)}  → true=${b.trueCount}  false=${b.falseCount}  skip=${b.skip}`);
  }
  console.log(`\nAlready set (skipped): ${alreadySet}`);
  console.log(`Will write:            ${data.length}`);
  console.log(`Skipped (unknown):     ${skippedUnknown}`);

  if (dry) {
    console.log(`\n--dry: not writing.`);
    return;
  }
  if (data.length === 0) {
    console.log(`\nNothing to write.`);
    return;
  }

  const sheets = google.sheets({ version: "v4", auth });
  const CHUNK = 500;
  for (let i = 0; i < data.length; i += CHUNK) {
    const slice = data.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: {
        valueInputOption: "RAW",
        data: slice
      }
    });
    console.log(`  wrote ${Math.min(i + CHUNK, data.length)}/${data.length}…`);
  }
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
