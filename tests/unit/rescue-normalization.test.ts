import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRescueDonor,
  normalizeRescueSlip,
  ensureRescueSkeleton,
  RESCUE_CATEGORIES,
  RESCUE_DONOR_CANONICAL
} from "../../src/extraction.js";
import type { ExtractionResult } from "../../src/types.js";

// Minimal ExtractionResult builder — only the fields the rescue helpers read.
function extraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    document_type: "manifest",
    supplier: "grocery_rescue",
    invoice_date: null,
    delivery_date: null,
    invoice_or_order_number: null,
    destination_org: null,
    donor_org: null,
    is_donation: true,
    line_items: [],
    fees: [],
    totals: { subtotal: null, tax: null, grand_total: null },
    source_warnings: [],
    ...overrides
  };
}

describe("normalizeRescueDonor", () => {
  it("returns already-canonical values unchanged", () => {
    for (const c of RESCUE_DONOR_CANONICAL) {
      assert.equal(normalizeRescueDonor(c), c);
    }
  });

  it("maps SWY-RB variants", () => {
    for (const v of ["Safeway Rainier", "SWY Rainier", "SWY-Rainier Beach", "Rainier Beach Safeway", "Rainier Safeway", "Safeway RB", "RB Safeway", "swyrb", "SWY-RB"]) {
      assert.equal(normalizeRescueDonor(v), "SWY-RB", `input="${v}"`);
    }
  });

  it("maps SWY-GEN variants", () => {
    for (const v of ["SWY Genesee", "Genesee Safeway", "Safeway Gen", "Safeway-G", "Gen Safeway", "safeway genesee"]) {
      assert.equal(normalizeRescueDonor(v), "SWY-GEN", `input="${v}"`);
    }
  });

  it("maps QFC-MI variants", () => {
    for (const v of ["QFC MI", "MI QFC", "QFC Mercer", "Mercer QFC", "QFC Mercer Island", "Mercer Island QFC", "MI-QFC"]) {
      assert.equal(normalizeRescueDonor(v), "QFC-MI", `input="${v}"`);
    }
  });

  it("maps QFC-BWY variants", () => {
    for (const v of ["QFC BWY", "QFC-B", "QFC-BW", "QFC Brdwy", "QFC Broadway", "Broadway QFC", "Brdwy QFC", "BWY QFC"]) {
      assert.equal(normalizeRescueDonor(v), "QFC-BWY", `input="${v}"`);
    }
  });

  it("maps HG variants (post-2026-07-22 rename)", () => {
    for (const v of ["HG", "hg", "Homegrown", "homegrown", "home grown", "HomeGrown"]) {
      assert.equal(normalizeRescueDonor(v), "HG", `input="${v}"`);
    }
  });

  it("returns null for unrecognized donors", () => {
    for (const v of ["Random Store", "Whole Foods", "Trader Joes", "xyz"]) {
      assert.equal(normalizeRescueDonor(v), null, `input="${v}"`);
    }
  });

  it("returns null for empty / whitespace input", () => {
    assert.equal(normalizeRescueDonor(null), null);
    assert.equal(normalizeRescueDonor(""), null);
    assert.equal(normalizeRescueDonor("   "), null);
    // Non-alpha-only strips to empty
    assert.equal(normalizeRescueDonor("---"), null);
    assert.equal(normalizeRescueDonor("123"), null);
  });

  it("does not misfire — non-canonical never returns a canonical by accident", () => {
    // Guardrail: substring-includes match shouldn't over-match.
    // The alias key "swy" would over-match if added — verify it's not.
    assert.equal(normalizeRescueDonor("swy"), null);
    // Similarly, "qfc" alone shouldn't map anywhere.
    assert.equal(normalizeRescueDonor("qfc"), null);
    assert.equal(normalizeRescueDonor("safeway"), null);
  });
});

describe("normalizeRescueSlip", () => {
  it("no-ops on non-grocery_rescue suppliers", () => {
    const e = extraction({ supplier: "carusos", donor_org: "Random", delivery_date: "2026-07-22" });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, "Random");
    assert.equal(e.invoice_or_order_number, null);
  });

  it("no-ops when donor_org is null", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: null });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, null);
    assert.equal(e.source_warnings.length, 0);
  });

  it("normalizes donor_org and synthesizes invoice_or_order_number", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "Safeway Rainier", delivery_date: "2026-07-22" });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, "SWY-RB");
    assert.equal(e.invoice_or_order_number, "SWY-RB-2026-07-22");
  });

  it("nulls donor + invoice + warns when donor is unrecognized", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "Random Store", delivery_date: "2026-07-22" });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, null);
    assert.equal(e.invoice_or_order_number, null);
    assert.equal(e.source_warnings.length, 1);
    assert.match(e.source_warnings[0], /donor_org unrecognized/);
  });

  it("skips invoice synth when delivery_date is null", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "SWY-RB", delivery_date: null });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, "SWY-RB");
    assert.equal(e.invoice_or_order_number, null);
  });

  it("keeps already-correct canonical + synth unchanged", () => {
    const e = extraction({
      supplier: "grocery_rescue",
      donor_org: "SWY-RB",
      delivery_date: "2026-07-22",
      invoice_or_order_number: "SWY-RB-2026-07-22"
    });
    normalizeRescueSlip(e);
    assert.equal(e.donor_org, "SWY-RB");
    assert.equal(e.invoice_or_order_number, "SWY-RB-2026-07-22");
    assert.equal(e.source_warnings.length, 0);
  });
});

describe("ensureRescueSkeleton", () => {
  it("no-ops on non-grocery_rescue suppliers", () => {
    const e = extraction({ supplier: "carusos", donor_org: "Random" });
    ensureRescueSkeleton(e);
    assert.equal(e.line_items.length, 0);
  });

  it("no-ops when donor_org is empty", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "" });
    ensureRescueSkeleton(e);
    assert.equal(e.line_items.length, 0);
  });

  it("fills all 10 categories from an empty extraction", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "SWY-RB" });
    ensureRescueSkeleton(e);
    assert.equal(e.line_items.length, 10, "should have exactly 10 category rows");
    const labels = new Set(e.line_items.map((li) => li.item_name_raw));
    for (const cat of RESCUE_CATEGORIES) {
      assert.ok(labels.has(cat.label), `missing category "${cat.label}"`);
    }
  });

  it("preserves existing category rows and fills the gaps", () => {
    const e = extraction({
      supplier: "grocery_rescue",
      donor_org: "SWY-RB",
      line_items: [{
        item_code_raw: null,
        item_name_raw: "Bakery",
        item_name_normalized: "Bakery",
        quantity_ordered: null,
        quantity: 50,
        quantity_raw: "50",
        unit: "lb",
        pack_size_raw: null,
        approx_weight: 50,
        category: "shelf_stable",
        unit_cost: null,
        line_total: null,
        is_fee: false,
        notes: null,
        confidence: 0.95
      }]
    });
    ensureRescueSkeleton(e);
    assert.equal(e.line_items.length, 10);
    // Bakery row's quantity should be preserved.
    const bakery = e.line_items.find((li) => li.item_name_raw === "Bakery");
    assert.equal(bakery?.quantity, 50, "existing Bakery quantity preserved");
    assert.equal(bakery?.approx_weight, 50);
  });

  it("emits categories in RESCUE_CATEGORIES order", () => {
    const e = extraction({ supplier: "grocery_rescue", donor_org: "QFC-MI" });
    ensureRescueSkeleton(e);
    const labels = e.line_items.map((li) => li.item_name_raw);
    const expected = RESCUE_CATEGORIES.map((c) => c.label);
    assert.deepEqual(labels, expected);
  });

  it("does not let Meat category eat a Non-Meat Protein row", () => {
    const e = extraction({
      supplier: "grocery_rescue",
      donor_org: "SWY-RB",
      line_items: [{
        item_code_raw: null,
        item_name_raw: "Non-Meat Protein (eggs, tofu)",
        item_name_normalized: "Non-Meat Protein",
        quantity_ordered: null,
        quantity: 18,
        quantity_raw: "18",
        unit: "lb",
        pack_size_raw: null,
        approx_weight: 18,
        category: "dairy",
        unit_cost: null,
        line_total: null,
        is_fee: false,
        notes: null,
        confidence: 0.9
      }]
    });
    ensureRescueSkeleton(e);
    assert.equal(e.line_items.length, 10);
    const nonMeat = e.line_items.find((li) => li.item_name_raw?.startsWith("Non-Meat"));
    assert.equal(nonMeat?.quantity, 18, "Non-Meat Protein row preserved with its quantity");
    // Meat row should be a fresh skeleton (no quantity).
    const meat = e.line_items.find((li) => li.item_name_raw === "Meat");
    assert.equal(meat?.quantity, null, "Meat row should be a fresh skeleton");
  });
});
