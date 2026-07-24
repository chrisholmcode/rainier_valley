/**
 * One-off: delete Inventory Summary rows whose (supplier, invoice_or_order_number)
 * no longer exists in the Inbound Delivery Log. Handles historical drift from
 * the grocery_rescue rename (PR #45) + invoice_or_order_number synthesis (PR
 * #51), which touched the delivery log but left old-shape summary rows behind.
 *
 * Safety:
 *   1. Dry-run by default; --apply required to actually delete.
 *   2. Always writes the orphans to ~/Downloads/orphan-summary-rows-<UTC>.csv
 *      before deleting (audit trail + trivial paste-back if we regret it).
 *   3. Deletes bottom-up so row numbers stay stable during the batch.
 *   4. Skips any orphan whose photo_url ALSO matches a delivery row — that
 *      shouldn't happen (would mean the backfill-recompute created a duplicate)
 *      but we'd rather surface it than silently drop data.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-summary-orphan-cleanup.ts [--apply]
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SUMMARY_SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function parseArgs(): { apply: boolean } {
  return { apply: process.argv.includes("--apply") };
}

function csvField(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
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

async function main(): Promise<void> {
  const { apply } = parseArgs();
  console.log(`# backfill-summary-orphan-cleanup · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const lastCol = indexToA1(SUMMARY_SHEET_HEADERS.length - 1);
  const [deliveryRows, summaryRes, meta] = await Promise.all([
    readDeliveryRows({ limit: 20000 }),
    sheets.spreadsheets.values.get({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      range: `${env.SUMMARY_WORKSHEET_NAME}!A:${lastCol}`
    }),
    sheets.spreadsheets.get({ spreadsheetId: env.GOOGLE_SPREADSHEET_ID })
  ]);
  const summaryRows = summaryRes.data.values ?? [];
  const summarySheet = meta.data.sheets?.find((s) => s.properties?.title === env.SUMMARY_WORKSHEET_NAME);
  const summarySheetId = summarySheet?.properties?.sheetId;
  if (summarySheetId == null) throw new Error(`Cannot find sheetId for ${env.SUMMARY_WORKSHEET_NAME}`);

  const header = summaryRows[0] ?? [];
  const iSupplier = header.indexOf("supplier");
  const iInvoice = header.indexOf("invoice_or_order_number");
  const iPhoto = header.indexOf("photo_url");
  if (iSupplier < 0 || iInvoice < 0 || iPhoto < 0) throw new Error(`Missing expected columns in ${env.SUMMARY_WORKSHEET_NAME}`);

  // Build lookup sets from the delivery log.
  const deliveryKeys = new Set<string>();
  const deliveryPhotos = new Set<string>();
  for (const r of deliveryRows) {
    const supplier = (r.supplier ?? "").trim();
    const invoice = (r.invoice_or_order_number ?? "").trim();
    if (supplier && invoice) deliveryKeys.add(`${supplier}::${invoice}`);
    if (r.photo_url) deliveryPhotos.add(r.photo_url);
  }

  // Classify each summary row.
  interface OrphanRow { rowNum: number; supplier: string; invoice: string; photoUrl: string; photoAlsoMatches: boolean; raw: unknown[]; }
  const orphans: OrphanRow[] = [];
  for (let i = 1; i < summaryRows.length; i++) {
    const row = summaryRows[i];
    const supplier = String(row[iSupplier] ?? "").trim();
    const invoice = String(row[iInvoice] ?? "").trim();
    const photoUrl = String(row[iPhoto] ?? "").trim();
    const key = `${supplier}::${invoice}`;
    if (supplier && invoice && deliveryKeys.has(key)) continue;
    orphans.push({
      rowNum: i + 1,
      supplier,
      invoice,
      photoUrl,
      photoAlsoMatches: photoUrl ? deliveryPhotos.has(photoUrl) : false,
      raw: row
    });
  }

  console.log(`Summary rows: ${summaryRows.length - 1}`);
  console.log(`Orphans found: ${orphans.length}`);
  const photoAmbiguous = orphans.filter((o) => o.photoAlsoMatches);
  console.log(`  ... of which have photo_url matching a live delivery row: ${photoAmbiguous.length} (skipped from deletion)`);
  console.log(``);

  const deletable = orphans.filter((o) => !o.photoAlsoMatches);
  console.log(`Deletable orphans (up to 20 shown):`);
  for (const o of deletable.slice(0, 20)) {
    console.log(`  row ${o.rowNum}: supplier="${o.supplier}" invoice="${o.invoice}" photo=${o.photoUrl ? "yes" : "no"}`);
  }
  if (deletable.length > 20) console.log(`  ... and ${deletable.length - 20} more`);
  console.log(``);

  if (photoAmbiguous.length > 0) {
    console.log(`Photo-ambiguous orphans (NOT deleting — inspect manually):`);
    for (const o of photoAmbiguous) {
      console.log(`  row ${o.rowNum}: supplier="${o.supplier}" invoice="${o.invoice}"`);
    }
    console.log(``);
  }

  if (deletable.length === 0) {
    console.log(`Nothing to delete. Done.`);
    return;
  }

  // Always dump the deletable orphans to a CSV audit trail before mutating.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(homedir(), "Downloads", `orphan-summary-rows-${stamp}.csv`);
  const backupLines: string[] = [];
  backupLines.push(["row_number", ...SUMMARY_SHEET_HEADERS].map(csvField).join(","));
  for (const o of deletable) {
    const cells: unknown[] = [];
    for (let i = 0; i < SUMMARY_SHEET_HEADERS.length; i++) cells.push(o.raw[i] ?? "");
    backupLines.push([o.rowNum, ...cells].map(csvField).join(","));
  }
  writeFileSync(backupPath, backupLines.join("\n") + "\n");
  console.log(`Backup written: ${backupPath}`);

  if (!apply) {
    console.log(`(dry-run — no rows deleted. Re-run with --apply to write.)`);
    return;
  }

  // Delete bottom-up so earlier row numbers stay valid.
  const requests: sheets_v4.Schema$Request[] = deletable
    .slice()
    .sort((a, b) => b.rowNum - a.rowNum)
    .map((o) => ({
      deleteDimension: {
        range: {
          sheetId: summarySheetId,
          dimension: "ROWS",
          startIndex: o.rowNum - 1,
          endIndex: o.rowNum
        }
      }
    }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { requests }
  });
  console.log(`Deleted ${requests.length} orphan row(s).`);
}

main().catch((err) => {
  console.error("cleanup failed:", (err as Error).message);
  process.exit(1);
});
