/**
 * One-off: fill in missing skeleton rows on historical grocery_rescue slips.
 *
 * `ensureRescueSkeleton` (in extraction.ts) is supposed to guarantee that
 * every rescue slip carries all 10 category rows — filling any not emitted
 * by the LLM with a null-pounds "no value on form" placeholder. Seven
 * historical slips from early July 2026 slipped through (extractor path
 * that didn't run the skeleton fill), showing 3–6 rows each in the Review
 * UI where 10 are expected.
 *
 * This script: groups grocery_rescue rows by invoice_or_order_number,
 * identifies which categories are missing on any short slip, and appends
 * skeleton rows to the sheet with matching slip-level fields + Slack keys
 * so they group under the same slip in the Review UI. Appended rows land
 * at the bottom of the sheet, not interleaved with the original rows —
 * order in the Review UI will show original rows first, then backfilled
 * skeletons.
 *
 * Idempotent: skips slips that already have all 10 category rows. Reruns
 * after apply are no-ops.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx src/backfill-rescue-skeleton-rows.ts [--apply]
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { SHEET_HEADERS } from "./sheets.js";
import { RESCUE_CATEGORIES } from "./extraction.js";

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

function normKey(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`Backfill rescue skeleton rows (${apply ? "APPLY" : "dry-run"})`);

  const lastCol = indexToA1(SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastCol}`
  });
  const rows = res.data.values ?? [];
  const idx = new Map(SHEET_HEADERS.map((h, i) => [h, i]));
  const supplierIdx = idx.get("supplier")!;
  const invoiceIdx = idx.get("invoice_or_order_number")!;

  // Group grocery_rescue rows by invoice number. Every rescue slip carries
  // the synthesized `<donor>-<date>` ID after PR #51, so this is a stable
  // slip identity.
  interface SlipGroup {
    invoice: string;
    templateRow: string[]; // one representative row (for cloning slip-level fields)
    presentCategories: Set<string>;
  }
  const bySlip = new Map<string, SlipGroup>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[supplierIdx] ?? "") !== "grocery_rescue") continue;
    const invoice = String(r[invoiceIdx] ?? "").trim();
    if (!invoice) continue;
    let g = bySlip.get(invoice);
    if (!g) {
      g = { invoice, templateRow: r, presentCategories: new Set() };
      bySlip.set(invoice, g);
    }
    // Match this row against a RESCUE_CATEGORIES entry so we know which
    // ones are present. Try item_name_raw first, then item_name_normalized,
    // then category as a fallback.
    const rawKey = normKey(String(r[idx.get("item_name_raw")!] ?? ""));
    const normKey2 = normKey(String(r[idx.get("item_name_normalized")!] ?? ""));
    for (const cat of RESCUE_CATEGORIES) {
      if (g.presentCategories.has(cat.label)) continue;
      const catKey = normKey(cat.label);
      const catNormKey = normKey(cat.normalized);
      if (rawKey === catKey || normKey2 === catNormKey) { g.presentCategories.add(cat.label); break; }
      if (cat.matchKeys.some((k) => rawKey.includes(k) || normKey2.includes(k))) {
        // Guard against Meat matching a Non-Meat Protein row.
        if (cat.label === "Meat" && (rawKey.includes("nonmeat") || normKey2.includes("nonmeat"))) continue;
        g.presentCategories.add(cat.label);
        break;
      }
    }
  }

  interface Plan {
    invoice: string;
    template: string[];
    missing: typeof RESCUE_CATEGORIES;
  }
  const plans: Plan[] = [];
  for (const g of bySlip.values()) {
    if (g.presentCategories.size >= RESCUE_CATEGORIES.length) continue;
    const missing = RESCUE_CATEGORIES.filter((c) => !g.presentCategories.has(c.label));
    plans.push({ invoice: g.invoice, template: g.templateRow, missing });
  }
  plans.sort((a, b) => a.invoice.localeCompare(b.invoice));

  const totalRowsToAppend = plans.reduce((a, p) => a + p.missing.length, 0);
  console.log(`\nSlips needing skeleton fill: ${plans.length}`);
  console.log(`Skeleton rows to append:     ${totalRowsToAppend}`);
  for (const p of plans) {
    const missNames = p.missing.map((m) => m.label).join(", ");
    console.log(`  ${p.invoice.padEnd(22)}  +${p.missing.length}  (missing: ${missNames})`);
  }

  if (plans.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  // Build appended rows using the template row for slip-level fields and
  // Slack keys. Overwrite the per-row fields with the skeleton values.
  const nowIso = new Date().toISOString();
  const appended: Array<Array<string | number | boolean>> = [];
  for (const p of plans) {
    for (const cat of p.missing) {
      const row: Array<string | number | boolean> = [...p.template];
      // Skeleton-specific fields (using RESCUE_CATEGORIES + the same defaults
      // ensureRescueSkeleton emits at ingest).
      row[idx.get("created_at")!] = nowIso;
      row[idx.get("item_code_raw")!] = "";
      row[idx.get("item_name_raw")!] = cat.label;
      row[idx.get("item_name_normalized")!] = cat.normalized;
      row[idx.get("quantity_ordered")!] = "";
      row[idx.get("quantity")!] = "";
      row[idx.get("quantity_raw")!] = "";
      row[idx.get("unit")!] = "lb";
      row[idx.get("pack_size_raw")!] = "";
      row[idx.get("approx_weight")!] = "";
      row[idx.get("category")!] = cat.category;
      row[idx.get("unit_cost")!] = "";
      row[idx.get("line_total")!] = "";
      row[idx.get("confidence")!] = 0.95;
      row[idx.get("is_fee")!] = false;
      row[idx.get("notes")!] = "no value on form (skeleton backfilled)";
      // Preserve: supplier, document_type, invoice_date, delivery_date,
      // invoice_or_order_number, destination_org, photo_url, slack_channel,
      // slack_message_ts, uploaded_by, warnings_json, donor_org, is_donation,
      // approved_at, approved_by (all from template).
      appended.push(row);
    }
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.GOOGLE_WORKSHEET_NAME}!A:${lastCol}`,
    valueInputOption: "RAW",
    requestBody: { values: appended as sheets_v4.Schema$ValueRange["values"] }
  });
  console.log(`\nAppended ${appended.length} skeleton row(s).`);
  console.log(`Done.`);
}

main().catch((err) => {
  console.error("backfill-rescue-skeleton-rows failed:", err);
  process.exit(1);
});
