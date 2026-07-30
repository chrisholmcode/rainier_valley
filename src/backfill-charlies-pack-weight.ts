/**
 * One-off: fill approx_weight for historical Charlie's rows by deriving from
 * pack_size_raw when the extractor left approx_weight blank. Only fills empty
 * cells — never overwrites an existing weight.
 *
 * Charlie's pack notation is `M NLB` (units-per-case × lb-per-unit), sometimes
 * elided to just `NLB` when M=1. Any pack that ends in CT or contains EACH is
 * count-only and gets skipped.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-charlies-pack-weight.ts [--apply] [--limit=N]
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

// Returns lb-per-case parsed from a Charlie's pack string, or null when the
// pack is count-only or unparseable. Handles:
//   "1 25LB"       → 25     "4 15LB"       → 60    "6 10LB" → 60
//   "25LB"         → 25     "50LB"         → 50    (M elided)
//   "1 12/3LB"     → 36     "1 12/1LB CELLO" → 12  (M × X/Y LB with optional suffix)
//   "12 18OZ"      → 13.5   (ounces → pounds via /16)
//   "1 40CT" → null  "8 JCT" → null  "72/EACH" → null  "1 12/1CM" → null
function packToLbPerCase(pack: string): number | null {
  const p = pack.trim().toUpperCase();
  if (!p) return null;
  // Anything mentioning CT or EACH is count-only, regardless of word-boundary
  // context (e.g., "60CT", "8 JCT", "1 56/64CT", "72/EACH").
  if (/CT/.test(p) || /EACH/.test(p)) return null;
  // "M X/YLB" (with optional trailing word like " CELLO") — M cases × X packs × Y lb.
  const slashLb = p.match(/^(\d+)\s+(\d+)\/(\d+(?:\.\d+)?)LB(?:\s+\w+)?$/);
  if (slashLb) return parseInt(slashLb[1], 10) * parseInt(slashLb[2], 10) * parseFloat(slashLb[3]);
  // "M NLB" (space-separated) — units × lb-per-unit.
  const spacedLb = p.match(/^(\d+)\s+(\d+(?:\.\d+)?)LB(?:\s+\w+)?$/);
  if (spacedLb) return parseInt(spacedLb[1], 10) * parseFloat(spacedLb[2]);
  // "NLB" (M elided, treat as 1).
  const bareLb = p.match(/^(\d+(?:\.\d+)?)LB$/);
  if (bareLb) return parseFloat(bareLb[1]);
  // "M NOZ" or "M X/YOZ" — ounces → lb.
  const slashOz = p.match(/^(\d+)\s+(\d+)\/(\d+(?:\.\d+)?)OZ$/);
  if (slashOz) return (parseInt(slashOz[1], 10) * parseInt(slashOz[2], 10) * parseFloat(slashOz[3])) / 16;
  const spacedOz = p.match(/^(\d+)\s+(\d+(?:\.\d+)?)OZ$/);
  if (spacedOz) return (parseInt(spacedOz[1], 10) * parseFloat(spacedOz[2])) / 16;
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
  console.log(`# backfill-charlies-pack-weight · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const rows = await readDeliveryRows({ limit: 20000 });
  const chRows = rows.filter((r) => r.supplier === "charlies");
  console.log(`Delivery rows total: ${rows.length}, charlies: ${chRows.length}`);

  const edits: Edit[] = [];
  let skippedAlreadyWeighed = 0;
  let skippedFee = 0;
  let skippedNoQty = 0;
  let skippedNoPack = 0;
  let skippedCountOnly = 0;
  let skippedUnparseable = 0;

  for (const r of chRows) {
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
      if (/CT|EACH/i.test(pack)) skippedCountOnly++;
      else skippedUnparseable++;
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
  console.log(`  count-only pack (CT/EACH):   ${skippedCountOnly}`);
  console.log(`  pack unparseable:            ${skippedUnparseable}`);
  console.log(``);

  const toApply = limit ? edits.slice(0, limit) : edits;
  console.log(`Total edits: ${edits.length}${limit ? ` (capped at --limit=${limit})` : ""}`);
  console.log(`First 20 edits:`);
  for (const e of toApply.slice(0, 20)) {
    console.log(`  row ${e.rowNumber}  ${e.itemCode.padEnd(11)} qty=${e.quantity} pack="${e.pack}" → ${e.newWeight} lb  (${e.itemName})`);
  }

  if (edits.length === 0) {
    console.log(`\nNothing to do.`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(homedir(), "Downloads", `charlies-pack-backfill-${stamp}.csv`);
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
