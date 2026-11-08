import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileCharliesTotalWeight } from "../../src/charliesTotalWeight.js";
import type { ExtractionResult } from "../../src/types.js";

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    document_type: "invoice",
    supplier: "charlies",
    invoice_date: "2026-10-15",
    delivery_date: "2026-10-15",
    invoice_or_order_number: "102249964",
    destination_org: "RVFB",
    donor_org: null,
    is_donation: false,
    line_items: [],
    fees: [],
    totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: null },
    source_warnings: [],
    ...overrides
  };
}

function lineItem(partial: Partial<ExtractionResult["line_items"][number]>): ExtractionResult["line_items"][number] {
  return {
    item_code_raw: null,
    item_name_raw: null,
    item_name_normalized: null,
    quantity_ordered: null,
    quantity: 1,
    quantity_raw: null,
    unit: "case",
    pack_size_raw: null,
    approx_weight: null,
    category: "produce",
    unit_cost: null,
    line_total: null,
    is_fee: false,
    notes: null,
    confidence: 1,
    ...partial
  };
}

describe("reconcileCharliesTotalWeight", () => {
  it("is a no-op when supplier is not charlies", () => {
    const e = makeExtraction({ supplier: "carusos", totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: 100 } });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "noop");
  });

  it("is a no-op when total_weight_lb is null", () => {
    const e = makeExtraction({ line_items: [lineItem({ approx_weight: 40, quantity: 10 })] });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "noop");
    assert.equal(e.line_items[0].approx_weight, 40, "must not rewrite when no printed total");
  });

  it("returns already_matches when Σ approx_weight ~= printed total", () => {
    const e = makeExtraction({
      totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: 820 },
      line_items: [
        lineItem({ approx_weight: 320, quantity: 8 }),
        lineItem({ approx_weight: 500, quantity: 10 })
      ]
    });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "already_matches");
    assert.equal(e.line_items[0].approx_weight, 320);
    assert.equal(e.source_warnings.length, 0);
  });

  it("rewrites per-case values when Σ(approx × qty) ~= printed total (Karey 102249964)", () => {
    const e = makeExtraction({
      totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: 1640 },
      line_items: [
        lineItem({ approx_weight: 40, quantity: 10, item_name_raw: "APPLE" }),
        lineItem({ approx_weight: 40, quantity: 10, item_name_raw: "YAM" }),
        lineItem({ approx_weight: 40, quantity: 10, item_name_raw: "ROMAINE" }),
        lineItem({ approx_weight: 25, quantity: 10, item_name_raw: "CARROT" }),
        lineItem({ approx_weight: 38, quantity: 5, item_name_raw: "LEMON" })
      ]
    });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "rewrote_per_case");
    assert.equal(r.rewrites, 5);
    assert.equal(e.line_items[0].approx_weight, 400);
    assert.equal(e.line_items[1].approx_weight, 400);
    assert.equal(e.line_items[2].approx_weight, 400);
    assert.equal(e.line_items[3].approx_weight, 250);
    assert.equal(e.line_items[4].approx_weight, 190);
    assert.match(e.line_items[0].notes ?? "", /charlies total-weight reconcile/);
    assert.equal(e.source_warnings.length, 1);
  });

  it("flags mismatch without rewriting when neither sum reconciles", () => {
    const e = makeExtraction({
      totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: 5000 },
      line_items: [
        lineItem({ approx_weight: 40, quantity: 10 }),
        lineItem({ approx_weight: 25, quantity: 10 })
      ]
    });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "flagged_mismatch");
    assert.equal(r.rewrites, 0);
    assert.equal(e.line_items[0].approx_weight, 40, "must not rewrite on unresolved mismatch");
    assert.equal(e.source_warnings.length, 1);
  });

  it("skips fee lines in the Σ", () => {
    const e = makeExtraction({
      totals: { subtotal: null, tax: null, grand_total: null, total_weight_lb: 400 },
      line_items: [
        lineItem({ approx_weight: 40, quantity: 10, item_name_raw: "APPLE" }),
        lineItem({ approx_weight: 5000, quantity: 1, is_fee: true, item_name_raw: "ENERGY CHARGE" })
      ]
    });
    const r = reconcileCharliesTotalWeight(e);
    assert.equal(r.action, "rewrote_per_case");
    assert.equal(e.line_items[0].approx_weight, 400);
    assert.equal(e.line_items[1].approx_weight, 5000, "must not touch fee rows");
  });
});
