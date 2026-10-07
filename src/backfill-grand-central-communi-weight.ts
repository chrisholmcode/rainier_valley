/**
 * One-off: fill approx_weight on Grand Central Community Loaf rows
 * (item_code_raw = COMMUNI) using the known per-unit weight (1.5 lb/ea =
 * standard 24 oz loaf). Idempotent — rows already carrying the correct
 * quantity × 1.5 weight are skipped.
 *
 * Rebuilds the Inventory Summary row for each touched slip so the dashboard
 * and coverage views see the corrected pound total.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-grand-central-communi-weight.ts [--apply]
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SHEET_HEADERS, recomputeSummaryForSlip } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

const COMMUNI_LB_PER_EA = 1.5;

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
  console.log(`# backfill-grand-central-communi-weight · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const rows = await readDeliveryRows({ limit: 20000 });
  const target = rows.filter((r) =>
    r.supplier === "grand_central" &&
    (r.item_code_raw ?? "").toUpperCase() === "COMMUNI"
  );
  console.log(`Grand Central COMMUNI rows: ${target.length}`);

  interface Edit {
    rowNumber: number;
    qty: number;
    prev: number | null;
    next: number;
    invoice: string;
    prevNotes: string;
    newNotes: string;
  }
  const edits: Edit[] = [];
  let skippedNoQty = 0;
  let skippedAlreadyCorrect = 0;
  for (const r of target) {
    const qty = parseFloat(r.quantity ?? "0");
    if (!Number.isFinite(qty) || qty <= 0) { skippedNoQty++; continue; }
    const next = Number((qty * COMMUNI_LB_PER_EA).toFixed(2));
    const prevRaw = r.approx_weight;
    const prev = prevRaw == null || prevRaw === "" ? null : parseFloat(prevRaw);
    const prevPresent = prev != null && Number.isFinite(prev);
    if (prevPresent && Math.abs(prev! - next) < 0.01) { skippedAlreadyCorrect++; continue; }
    const fragment = `[grand_central backfill: weight ${prevPresent ? prev : "null"}→${next} lb (${COMMUNI_LB_PER_EA}×${qty}); COMMUNI = Community Loaf, 24 oz standard]`;
    const prevNotes = r.notes ?? "";
    edits.push({
      rowNumber: r.rowIndex,
      qty,
      prev: prevPresent ? prev : null,
      next,
      invoice: r.invoice_or_order_number ?? "",
      prevNotes,
      newNotes: prevNotes ? `${prevNotes} ${fragment}` : fragment
    });
  }

  console.log(`Skipped (no qty): ${skippedNoQty}`);
  console.log(`Skipped (already correct): ${skippedAlreadyCorrect}`);
  console.log(`Planned edits: ${edits.length}`);
  for (const e of edits) {
    console.log(`  row ${e.rowNumber}  inv=${e.invoice}  qty=${e.qty}  ${e.prev ?? "∅"} → ${e.next}`);
  }
  if (edits.length === 0) {
    console.log("Nothing to do.");
    return;
  }
  if (!apply) {
    console.log("(dry-run — no writes. Re-run with --apply.)");
    return;
  }

  const wIdx = SHEET_HEADERS.indexOf("approx_weight");
  const nIdx = SHEET_HEADERS.indexOf("notes");
  if (wIdx < 0 || nIdx < 0) throw new Error("approx_weight/notes missing from SHEET_HEADERS");
  const wCol = indexToA1(wIdx);
  const nCol = indexToA1(nIdx);
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const e of edits) {
    updates.push({ range: `${env.GOOGLE_WORKSHEET_NAME}!${wCol}${e.rowNumber}`, values: [[e.next]] });
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
  console.log(`Wrote ${updates.length} cell(s) across ${edits.length} rows.`);

  // Recompute Inventory Summary for each touched (supplier, invoice) group.
  // Re-read rows so the recompute sees the newly-written weights.
  const uniqueInvoices = Array.from(new Set(edits.map((e) => e.invoice).filter(Boolean)));
  console.log(`\nRecomputing Inventory Summary for ${uniqueInvoices.length} slip(s)…`);
  const freshRows = await readDeliveryRows({ limit: 20000 });
  let ok = 0, fail = 0;
  for (const inv of uniqueInvoices) {
    const slipRows = freshRows.filter((r) => r.supplier === "grand_central" && (r.invoice_or_order_number ?? "") === inv);
    if (slipRows.length === 0) {
      console.warn(`  no rows found for ${inv}`);
      fail++;
      continue;
    }
    try {
      await recomputeSummaryForSlip(slipRows);
      console.log(`  ${inv} — ${slipRows.length} rows · recomputed`);
      ok++;
    } catch (err) {
      console.warn(`  recompute failed for ${inv}: ${(err as Error).message}`);
      fail++;
    }
  }
  console.log(`Summary recompute: ok=${ok} fail=${fail}`);
}

main().catch((err) => {
  console.error("backfill failed:", (err as Error).message);
  process.exit(1);
});
