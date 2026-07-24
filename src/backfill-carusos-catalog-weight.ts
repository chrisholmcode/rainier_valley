/**
 * One-off: reconcile every Carusos row in the Inbound Delivery Log against the
 * scraped Caruso catalog, writing the correct per-line approx_weight
 * (catalog_per_case × quantity). Fixes two classes of drift:
 *
 *   1. Historical rows with empty approx_weight (200 rows as of 2026-07-24 —
 *      the catalog reconciliation is only wired into the live-ingest path in
 *      index.ts, so anything predating that never got a catalog weight).
 *   2. Rows where approx_weight is currently stored as the per-case value
 *      (54/80 rows as of audit) — the pre-fix reconciliation logic wrote
 *      cat.weightLb directly without multiplying by quantity.
 *
 * Idempotent: only writes when the correct per-line weight differs from what's
 * in the sheet. Skips catalog misses and catalog rows with no weight (mostly
 * `kind: ct_only` items where the pack is count-based).
 *
 * Also appends a note to the row's `notes` column so reviewers can see what
 * changed and why.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-carusos-catalog-weight.ts [--apply] [--limit=N]
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SHEET_HEADERS } from "./sheets.js";
import { lookupCarusoBySku } from "./carusoCatalog.js";

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

interface Edit {
  rowNumber: number;
  invoice: string;
  sku: string;
  itemName: string;
  quantity: number;
  prevWeight: number | null;
  newWeight: number;
  reason: "fill_missing" | "correct_per_case" | "other_mismatch";
  prevNotes: string;
  newNotes: string;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  console.log(`# backfill-carusos-catalog-weight · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const rows = await readDeliveryRows({ limit: 20000 });
  const carRows = rows.filter((r) => r.supplier === "carusos");
  console.log(`Delivery rows total: ${rows.length}, carusos: ${carRows.length}`);

  const edits: Edit[] = [];
  let skippedNoSku = 0;
  let skippedCatalogMiss = 0;
  let skippedNoWeight = 0;
  let skippedAlreadyCorrect = 0;

  for (const r of carRows) {
    const sku = (r.item_code_raw ?? "").trim();
    if (!sku) { skippedNoSku++; continue; }
    const cat = lookupCarusoBySku(sku);
    if (!cat) { skippedCatalogMiss++; continue; }
    if (cat.weightLb == null) { skippedNoWeight++; continue; }

    const qty = parseFloat(r.quantity ?? "0");
    const effectiveQty = Number.isFinite(qty) && qty > 0 ? qty : 1;
    const newWeight = Number((cat.weightLb * effectiveQty).toFixed(2));

    const prevRaw = r.approx_weight;
    const prevWeight = prevRaw == null || prevRaw === "" ? null : parseFloat(prevRaw);
    const prevPresent = prevWeight != null && Number.isFinite(prevWeight);

    // Idempotent: skip when already correct.
    if (prevPresent && Math.abs(prevWeight! - newWeight) < 0.01) {
      skippedAlreadyCorrect++;
      continue;
    }

    let reason: Edit["reason"];
    if (!prevPresent) reason = "fill_missing";
    else if (Math.abs(prevWeight! - cat.weightLb) < 0.01 && effectiveQty > 1) reason = "correct_per_case";
    else reason = "other_mismatch";

    const noteFragment = `[catalog backfill: weight ${prevPresent ? prevWeight : "null"}→${newWeight} lb (${cat.weightLb}×${effectiveQty}); sku ${cat.sku} ${cat.name}]`;
    const prevNotes = r.notes ?? "";
    const newNotes = prevNotes ? `${prevNotes} ${noteFragment}` : noteFragment;

    edits.push({
      rowNumber: r.rowIndex,
      invoice: (r.invoice_or_order_number ?? "").trim(),
      sku,
      itemName: r.item_name_raw ?? r.item_name_normalized ?? "",
      quantity: effectiveQty,
      prevWeight: prevPresent ? prevWeight : null,
      newWeight,
      reason,
      prevNotes,
      newNotes
    });
  }

  console.log(``);
  console.log(`Skip counters:`);
  console.log(`  no SKU on row:             ${skippedNoSku}`);
  console.log(`  catalog miss (SKU not in catalog): ${skippedCatalogMiss}`);
  console.log(`  catalog hit but no weight (ct_only, volume, etc.): ${skippedNoWeight}`);
  console.log(`  already correct (idempotent skip): ${skippedAlreadyCorrect}`);
  console.log(``);

  const byReason: Record<Edit["reason"], number> = { fill_missing: 0, correct_per_case: 0, other_mismatch: 0 };
  for (const e of edits) byReason[e.reason]++;
  console.log(`Edits by reason:`);
  console.log(`  fill_missing:      ${byReason.fill_missing}`);
  console.log(`  correct_per_case:  ${byReason.correct_per_case}  (bug fix: stored per-case → per-line)`);
  console.log(`  other_mismatch:    ${byReason.other_mismatch}  (existing weight differs from catalog × quantity)`);
  console.log(``);

  const toApply = limit ? edits.slice(0, limit) : edits;
  console.log(`Total edits: ${edits.length}${limit ? ` (capped at --limit=${limit})` : ""}`);
  console.log(`First 15 edits:`);
  for (const e of toApply.slice(0, 15)) {
    console.log(`  row ${e.rowNumber}  inv=${e.invoice}  sku=${e.sku}  qty=${e.quantity}  ${e.prevWeight ?? "∅"} → ${e.newWeight}  (${e.reason})`);
  }

  if (edits.length === 0) {
    console.log(`\nNothing to do.`);
    return;
  }

  // Always dump the planned edits to CSV for the audit trail.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(homedir(), "Downloads", `carusos-catalog-backfill-${stamp}.csv`);
  const lines = [["row_number","invoice","sku","item_name","quantity","prev_weight","new_weight","reason","prev_notes"].map(csvField).join(",")];
  for (const e of toApply) {
    lines.push([e.rowNumber, e.invoice, e.sku, e.itemName, e.quantity, e.prevWeight ?? "", e.newWeight, e.reason, e.prevNotes].map(csvField).join(","));
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

  // Sheets caps each batchUpdate at ~100 requests before rate-limit pressure.
  // Chunk to be safe.
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
