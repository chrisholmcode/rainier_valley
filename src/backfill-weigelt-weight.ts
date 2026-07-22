/**
 * One-off: for Weigelt invoices where Qty IS the billed weight in pounds,
 * backfill approx_weight = quantity and unit = "lb" on existing Inbound Delivery
 * Log rows, then recompute weight_lb on the matching Inventory Summary rows.
 *
 * Usage:
 *   npx tsx src/backfill-weigelt-weight.ts [--date=YYYY-MM-DD] [--field=created|delivery] [--apply]
 *
 *   --date   defaults to yesterday; matches rows whose date field starts with the given day.
 *   --field  which column to filter on. Defaults to "created" (created_at) — that's the
 *            common "slips uploaded yesterday" interpretation. Use "delivery" if you want
 *            to filter by delivery_date instead.
 *   --apply  required to actually write. Without it, prints a dry-run diff.
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS, SUMMARY_SHEET_HEADERS } from "./sheets.js";

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

function normalizeInvoice(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.replace(/^0+/, "") || "0";
}

function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseArgs(): { date: string; apply: boolean; field: "created" | "delivery" } {
  let date = yesterdayIso();
  let apply = false;
  let field: "created" | "delivery" = "created";
  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--date=")) date = arg.slice("--date=".length).trim();
    else if (arg === "--field=created" || arg === "--field=delivery") field = arg.slice("--field=".length) as "created" | "delivery";
  }
  return { date, apply, field };
}

async function main(): Promise<void> {
  const { date, apply, field } = parseArgs();
  const dateColumnName = field === "created" ? "created_at" : "delivery_date";
  console.log(`Backfilling Weigelt slips where ${dateColumnName} starts with ${date} (${apply ? "APPLY" : "dry-run"})`);

  const logRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const logRows = logRes.data.values ?? [];
  const idx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supIdx = idx.get("supplier")!;
  const createdIdx = idx.get("created_at")!;
  const deliveryIdx = idx.get("delivery_date")!;
  const dateIdx = field === "created" ? createdIdx : deliveryIdx;
  const invIdx = idx.get("invoice_or_order_number")!;
  const qtyIdx = idx.get("quantity")!;
  const unitIdx = idx.get("unit")!;
  const weightIdx = idx.get("approx_weight")!;
  const isFeeIdx = idx.get("is_fee")!;
  const codeIdx = idx.get("item_code_raw")!;
  const nameIdx = idx.get("item_name_raw")!;

  interface RowEdit {
    rowNumber: number;
    invoice: string;
    itemLabel: string;
    quantity: number;
    prevWeight: string;
    prevUnit: string;
    newWeight: number;
    setUnit: boolean;
    isFee: boolean;
  }
  const edits: RowEdit[] = [];
  const invoicesTouched = new Set<string>();

  for (let i = 1; i < logRows.length; i++) {
    const r = logRows[i];
    if ((r[supIdx] ?? "") !== "weigelt") continue;
    if (!String(r[dateIdx] ?? "").startsWith(date)) continue;
    const isFee = (r[isFeeIdx] ?? "").toString().toUpperCase() === "TRUE";
    const qtyRaw = r[qtyIdx];
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty)) continue;
    const prevWeight = r[weightIdx] ?? "";
    const prevUnit = r[unitIdx] ?? "";
    const newWeight = qty;
    const weightDiffers = String(prevWeight).trim() === "" || Number(prevWeight) !== newWeight;
    const setUnit = !isFee && prevUnit !== "lb";
    if (isFee) {
      // Fee rows: leave approx_weight/unit alone.
      continue;
    }
    if (!weightDiffers && !setUnit) continue;

    const invoice = normalizeInvoice(r[invIdx]);
    invoicesTouched.add(invoice);
    edits.push({
      rowNumber: i + 1,
      invoice,
      itemLabel: `[${r[codeIdx] ?? "?"}] ${r[nameIdx] ?? ""}`,
      quantity: qty,
      prevWeight: String(prevWeight),
      prevUnit: String(prevUnit),
      newWeight,
      setUnit,
      isFee
    });
  }

  console.log(`\nFound ${edits.length} row(s) to update across ${invoicesTouched.size} invoice(s):`);
  for (const e of edits) {
    console.log(
      `  row ${e.rowNumber}  inv=${e.invoice}  ${e.itemLabel}  qty=${e.quantity}  weight ${e.prevWeight || "∅"} -> ${e.newWeight}${e.setUnit ? `  unit "${e.prevUnit}" -> lb` : ""}`
    );
  }

  if (edits.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  // ── Write row-level updates ─────────────────────────────────────────────
  const wCol = indexToA1(weightIdx);
  const uCol = indexToA1(unitIdx);
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const e of edits) {
    updates.push({
      range: `${env.GOOGLE_WORKSHEET_NAME}!${wCol}${e.rowNumber}`,
      values: [[e.newWeight]]
    });
    if (e.setUnit) {
      updates.push({
        range: `${env.GOOGLE_WORKSHEET_NAME}!${uCol}${e.rowNumber}`,
        values: [["lb"]]
      });
    }
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: { valueInputOption: "RAW", data: updates }
  });
  console.log(`\nWrote ${updates.length} cell update(s) to ${env.GOOGLE_WORKSHEET_NAME}.`);

  // ── Recompute Inventory Summary weight_lb per touched invoice ───────────
  // Re-read the log so we sum against the freshly written values.
  const freshRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:Z`
  });
  const freshRows = freshRes.data.values ?? [];
  const weightByInvoice = new Map<string, number>();
  for (let i = 1; i < freshRows.length; i++) {
    const r = freshRows[i];
    if ((r[supIdx] ?? "") !== "weigelt") continue;
    const inv = normalizeInvoice(r[invIdx]);
    if (!invoicesTouched.has(inv)) continue;
    if ((r[isFeeIdx] ?? "").toString().toUpperCase() === "TRUE") continue;
    const w = Number(r[weightIdx]);
    if (!Number.isFinite(w)) continue;
    weightByInvoice.set(inv, (weightByInvoice.get(inv) ?? 0) + w);
  }

  const summaryRes = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.SUMMARY_WORKSHEET_NAME}!A:Z`
  });
  const sumRows = summaryRes.data.values ?? [];
  const sIdx = new Map(SUMMARY_SHEET_HEADERS.map((h, i) => [h, i]));
  const sSup = sIdx.get("supplier")!;
  const sInv = sIdx.get("invoice_or_order_number")!;
  const sW = sIdx.get("weight_lb")!;
  const sU = sIdx.get("unit")!;
  const wColSum = indexToA1(sW);
  const uColSum = indexToA1(sU);

  const summaryUpdates: sheets_v4.Schema$ValueRange[] = [];
  for (let i = 1; i < sumRows.length; i++) {
    if ((sumRows[i][sSup] ?? "") !== "weigelt") continue;
    const inv = normalizeInvoice(sumRows[i][sInv]);
    if (!invoicesTouched.has(inv)) continue;
    const total = weightByInvoice.get(inv) ?? 0;
    const newWeight = total > 0 ? Number(total.toFixed(2)) : null;
    summaryUpdates.push({
      range: `${env.SUMMARY_WORKSHEET_NAME}!${wColSum}${i + 1}`,
      values: [[newWeight]]
    });
    summaryUpdates.push({
      range: `${env.SUMMARY_WORKSHEET_NAME}!${uColSum}${i + 1}`,
      values: [["lb"]]
    });
    console.log(`  Summary row ${i + 1}  inv=${inv}  weight_lb -> ${newWeight}`);
  }
  if (summaryUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: summaryUpdates }
    });
    console.log(`Wrote ${summaryUpdates.length} cell update(s) to ${env.SUMMARY_WORKSHEET_NAME}.`);
  }
}

main().catch((err) => {
  console.error("backfill-weigelt-weight failed:", err);
  process.exit(1);
});
