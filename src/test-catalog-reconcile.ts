import { reconcileWithCarusoCatalog } from "./carusoCatalog.js";
import type { ExtractionResult } from "./types.js";

function synth(supplier: ExtractionResult["supplier"], items: Array<Partial<ExtractionResult["line_items"][number]> & { item_code_raw: string | null }>): ExtractionResult {
  return {
    document_type: "invoice",
    supplier,
    delivery_date: "2026-07-02",
    invoice_or_order_number: "TEST",
    destination_org: "RVFB",
    donor_org: null,
    is_donation: false,
    fees: [],
    totals: { subtotal: null, tax: null, grand_total: null },
    source_warnings: [],
    line_items: items.map((it) => ({
      item_code_raw: it.item_code_raw,
      item_name_raw: it.item_name_raw ?? null,
      item_name_normalized: it.item_name_normalized ?? null,
      quantity_ordered: it.quantity_ordered ?? null,
      quantity: it.quantity ?? null,
      quantity_raw: it.quantity_raw ?? null,
      unit: it.unit ?? null,
      pack_size_raw: it.pack_size_raw ?? null,
      approx_weight: it.approx_weight ?? null,
      category: it.category ?? "produce",
      unit_cost: it.unit_cost ?? null,
      line_total: it.line_total ?? null,
      is_fee: it.is_fee ?? false,
      notes: it.notes ?? null,
      confidence: it.confidence ?? 1
    }))
  };
}

console.log("--- carusos: mix of hits and misses ---");
const e1 = synth("carusos", [
  { item_code_raw: "00683", item_name_raw: "CARROT JUMBO", approx_weight: 30 },   // hit, will overwrite 30→25
  { item_code_raw: "00877", item_name_raw: "CUCUMBER ENGLISH", approx_weight: null }, // hit, was null → 10
  { item_code_raw: "02110", item_name_raw: "ORANGE NAVEL", approx_weight: 38 },   // hit, matches (no overwrite)
  { item_code_raw: "99999", item_name_raw: "MYSTERY", approx_weight: 12 },        // miss
  { item_code_raw: null, item_name_raw: "NOSKU", approx_weight: 7 }               // no sku
]);
const r1 = reconcileWithCarusoCatalog(e1);
console.log("stats:", r1);
for (const li of e1.line_items) console.log("  ", li.item_code_raw, "wt=" + li.approx_weight, "notes=" + (li.notes ?? "-"));
console.log("warnings:", e1.source_warnings);

console.log("\n--- non-caruso supplier: no-op ---");
const e2 = synth("charlies", [{ item_code_raw: "00683", approx_weight: 999 }]);
const r2 = reconcileWithCarusoCatalog(e2);
console.log("stats:", r2, "weight preserved?", e2.line_items[0].approx_weight === 999);

console.log("\n--- zero-stripped sku: '683' should still hit ---");
const e3 = synth("carusos", [{ item_code_raw: "683", approx_weight: null }]);
const r3 = reconcileWithCarusoCatalog(e3);
console.log("stats:", r3, "weight=" + e3.line_items[0].approx_weight);
