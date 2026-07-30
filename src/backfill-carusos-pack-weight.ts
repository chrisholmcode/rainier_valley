/**
 * One-off: fill approx_weight for historical Caruso's rows by deriving from
 * pack_size_raw. Complements backfill-carusos-catalog-weight.ts, which only
 * fires when the SKU hits the scraped catalog. This script handles the ~85
 * catalog-miss rows (SKUs the scraper never picked up) where the pack notation
 * on the row itself carries enough info to derive a weight.
 *
 * Caruso pack rules (must match prompts/invoice/suppliers/carusos.md):
 *   N#         → N lb per case             (e.g., "28#", "25#")
 *   N/M#       → N × M lb per case         (e.g., "12/1#")
 *   N/M OZ     → N × M / 16 lb per case    (e.g., "12/6 OZ")
 *   N CT / N/M CT → count-only, null
 *
 * Only fills empty cells — never overwrites an existing weight.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-carusos-pack-weight.ts [--apply] [--limit=N]
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function parseArgs(): { apply: boolean; limit?: number } {
  const args = process.argv.slice(2);
  let apply = false;
  let limit: number | undefined;
  for (const a of args) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--limit=")) limit = parseInt(a.slice("--limit=".length), 10);
  }
  return { apply, limit };
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

// Parse a Caruso pack string → lb-per-case, or null when count-only /
// unparseable. Handles all forms seen on the invoices: "N#", "N /#", "N/M#",
// "N/M OZ", trailing size codes like "30's TP", "24 #" (space between number
// and #), and count-only "N CT" / "N/M CT".
function packToLbPerCase(pack: string): number | null {
  const p = pack.trim().toUpperCase();
  if (!p) return null;
  // Count-only.
  if (/\bCT\b/.test(p) || /'S\b/.test(p)) return null;
  // "N/M#" — units × lb-per-unit (with optional space around #).
  const slashPound = p.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*#$/);
  if (slashPound) return parseInt(slashPound[1], 10) * parseFloat(slashPound[2]);
  // "N#" — pounds per case (with optional space).
  const bareLb = p.match(/^(\d+(?:\.\d+)?)\s*#$/);
  if (bareLb) return parseFloat(bareLb[1]);
  // "N/M OZ" — ounces → lb.
  const slashOz = p.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*OZ$/);
  if (slashOz) return (parseInt(slashOz[1], 10) * parseFloat(slashOz[2])) / 16;
  // "N OZ" — bare ounces.
  const bareOz = p.match(/^(\d+(?:\.\d+)?)\s*OZ$/);
  if (bareOz) return parseFloat(bareOz[1]) / 16;
  // "N LB" — sometimes written with LB instead of #.
  const bareLbWord = p.match(/^(\d+(?:\.\d+)?)\s*LB$/);
  if (bareLbWord) return parseFloat(bareLbWord[1]);
  const slashLbWord = p.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*LB$/);
  if (slashLbWord) return parseInt(slashLbWord[1], 10) * parseFloat(slashLbWord[2]);
  return null;
}

interface Edit {
  rowNumber: number;
  invoice: string;
  itemCode: string;
  itemName: string;
  quantity: number;
  pack: string;
  lbPerCase: number;
  newWeight: number;
  prevNotes: string;
  newNotes: string;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  console.log(`# backfill-carusos-pack-weight · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const rows = await readDeliveryRows({ limit: 20000 });
  const carRows = rows.filter((r) => r.supplier === "carusos");
  console.log(`Delivery rows total: ${rows.length}, carusos: ${carRows.length}`);

  const edits: Edit[] = [];
  let skippedFee = 0;
  let skippedAlreadyWeighed = 0;
  let skippedNoQty = 0;
  let skippedNoPack = 0;
  let skippedCountOnly = 0;
  let skippedUnparseable = 0;
  const unparseablePacks = new Map<string, number>();

  for (const r of carRows) {
    if ((r.is_fee ?? "").toString().toLowerCase() === "true") { skippedFee++; continue; }
    const prevRaw = (r.approx_weight ?? "").trim();
    const prevWeight = prevRaw === "" ? null : parseFloat(prevRaw);
    if (prevWeight != null && Number.isFinite(prevWeight) && prevWeight > 0) {
      skippedAlreadyWeighed++;
      continue;
    }
    const qty = parseFloat(r.quantity ?? "0");
    if (!Number.isFinite(qty) || qty <= 0) { skippedNoQty++; continue; }
    const pack = (r.pack_size_raw ?? "").trim();
    if (!pack) { skippedNoPack++; continue; }
    const lbPerCase = packToLbPerCase(pack);
    if (lbPerCase == null) {
      if (/CT|'S/i.test(pack)) skippedCountOnly++;
      else {
        skippedUnparseable++;
        unparseablePacks.set(pack, (unparseablePacks.get(pack) ?? 0) + 1);
      }
      continue;
    }
    const newWeight = Number((qty * lbPerCase).toFixed(2));
    const noteFragment = `[pack backfill: weight ∅→${newWeight} lb (${lbPerCase}×${qty} from pack ${pack})]`;
    const prevNotes = r.notes ?? "";
    const newNotes = prevNotes ? `${prevNotes} ${noteFragment}` : noteFragment;

    edits.push({
      rowNumber: r.rowIndex,
      invoice: (r.invoice_or_order_number ?? "").trim(),
      itemCode: (r.item_code_raw ?? "").trim(),
      itemName: r.item_name_raw ?? r.item_name_normalized ?? "",
      quantity: qty,
      pack,
      lbPerCase,
      newWeight,
      prevNotes,
      newNotes
    });
  }

  console.log(``);
  console.log(`Skip counters:`);
  console.log(`  fee row:                     ${skippedFee}`);
  console.log(`  already weighed:             ${skippedAlreadyWeighed}`);
  console.log(`  quantity 0 or missing:       ${skippedNoQty}`);
  console.log(`  pack blank:                  ${skippedNoPack}`);
  console.log(`  count-only pack (CT/'S):     ${skippedCountOnly}`);
  console.log(`  pack unparseable:            ${skippedUnparseable}`);
  if (unparseablePacks.size > 0) {
    console.log(`  distinct unparseable packs:`);
    for (const [p, n] of Array.from(unparseablePacks.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${n.toString().padStart(3)} × "${p}"`);
    }
  }
  console.log(``);

  const toApply = limit ? edits.slice(0, limit) : edits;
  console.log(`Total edits: ${edits.length}${limit ? ` (capped at --limit=${limit})` : ""}`);
  console.log(`First 20 edits:`);
  for (const e of toApply.slice(0, 20)) {
    console.log(`  row ${e.rowNumber}  ${e.itemCode.padEnd(6)} qty=${e.quantity} pack="${e.pack}" → ${e.newWeight} lb  (${e.itemName})`);
  }

  if (edits.length === 0) {
    console.log(`\nNothing to do.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(homedir(), "Downloads", `carusos-pack-backfill-${stamp}.csv`);
  const lines = [["row_number","invoice","item_code","item_name","quantity","pack","lb_per_case","new_weight","prev_notes"].map(csvField).join(",")];
  for (const e of toApply) {
    lines.push([e.rowNumber, e.invoice, e.itemCode, e.itemName, e.quantity, e.pack, e.lbPerCase, e.newWeight, e.prevNotes].map(csvField).join(","));
  }
  writeFileSync(backupPath, lines.join("\n") + "\n");
  console.log(`\nBackup written: ${backupPath}`);

  if (!apply) {
    console.log(`(dry-run — no writes. Re-run with --apply to write.)`);
    return;
  }

  const weightIdx = SHEET_HEADERS.indexOf("approx_weight");
  const notesIdx = SHEET_HEADERS.indexOf("notes");
  if (weightIdx < 0 || notesIdx < 0) throw new Error("Missing approx_weight or notes column in SHEET_HEADERS");
  const wCol = indexToA1(weightIdx);
  const nCol = indexToA1(notesIdx);

  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const e of toApply) {
    updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${wCol}${e.rowNumber}`, values: [[e.newWeight]] });
    updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${nCol}${e.rowNumber}`, values: [[e.newNotes]] });
  }

  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: chunk }
    });
    console.log(`  wrote batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(updates.length / CHUNK)} (${chunk.length} cells)`);
  }
  console.log(`\nWrote ${updates.length} cell update(s) across ${toApply.length} row(s).`);
  console.log(`\nNext: rerun src/backfill-summary-recompute.ts --apply to propagate the corrected weights into Inventory Summary.`);
}

main().catch((err) => {
  console.error("backfill failed:", (err as Error).message);
  process.exit(1);
});
