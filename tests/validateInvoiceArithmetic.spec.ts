/**
 * Unit tests for validateInvoiceArithmetic — the post-extraction backstop that
 * catches the "grabbed APPROX.WT. instead of SHIP" failure mode on Charlie's
 * Produce invoices.
 *
 * Pure function, no network. Numbers are taken from the real Charlie's fixture
 * (tests/fixtures/IMG_2721.jpg): AVOCADO,HASS GREEN shipped 20 cases @ $21.45 =
 * $429.00, with an APPROX.WT. of 25.00 lb sitting in the column the model is
 * prone to misread as the quantity.
 *
 * Run: `npm run test:unit`
 */

// config.ts validates required env at import time; set throwaway values so the
// module graph (which constructs the Anthropic client) loads without a key.
process.env.SLACK_BOT_TOKEN ??= "test";
process.env.SLACK_SIGNING_SECRET ??= "test";
process.env.ANTHROPIC_API_KEY ??= "test";
process.env.GOOGLE_SPREADSHEET_ID ??= "test";

const { validateInvoiceArithmetic } = await import("../src/extraction.js");
import type { ExtractionResult } from "../src/types.js";

type LineItem = ExtractionResult["line_items"][number];

function lineItem(overrides: Partial<LineItem>): LineItem {
  return {
    item_code_raw: null,
    item_name_raw: null,
    item_name_normalized: null,
    quantity: null,
    quantity_raw: null,
    unit: "case",
    pack_size_raw: null,
    category: "produce",
    unit_cost: null,
    line_total: null,
    is_fee: false,
    notes: null,
    confidence: 0.95,
    ...overrides
  };
}

function extraction(lineItems: LineItem[]): ExtractionResult {
  return {
    document_type: "invoice",
    supplier: "charlies",
    delivery_date: "2026-02-05",
    invoice_or_order_number: "7172545",
    destination_org: "Rainier Valley Food Bank",
    line_items: lineItems,
    fees: [],
    totals: { subtotal: null, tax: null, grand_total: null },
    source_warnings: []
  };
}

let failures = 0;
function assert(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1) The core regression: quantity = APPROX.WT. (25) gets auto-corrected to SHIP (20).
{
  console.log("\n▶ corrects qty when APPROX.WT. was grabbed instead of SHIP");
  const result = validateInvoiceArithmetic(
    extraction([
      lineItem({ item_name_normalized: "Avocado, Hass Green", quantity: 25, unit_cost: 21.45, line_total: 429.0 })
    ])
  );
  const item = result.line_items[0];
  assert("quantity corrected to 20", item.quantity === 20, `got ${item.quantity}`);
  assert("confidence capped at 0.7", item.confidence <= 0.7, `got ${item.confidence}`);
  assert("notes records the auto-correction", (item.notes ?? "").includes("auto-corrected"), `got "${item.notes}"`);
  assert("one source warning added", result.source_warnings.length === 1, `got ${result.source_warnings.length}`);
  assert(
    "warning mentions the item and APPROX.WT.",
    result.source_warnings[0].includes("Avocado") && result.source_warnings[0].includes("APPROX.WT."),
    result.source_warnings[0]
  );
}

// 2) A clean line where qty × price = total is left untouched.
{
  console.log("\n▶ leaves an arithmetically-consistent line untouched");
  const original = extraction([
    lineItem({ item_name_normalized: "Avocado, Hass Green", quantity: 20, unit_cost: 21.45, line_total: 429.0, confidence: 0.95 })
  ]);
  const result = validateInvoiceArithmetic(original);
  assert("quantity unchanged", result.line_items[0].quantity === 20);
  assert("confidence unchanged", result.line_items[0].confidence === 0.95);
  assert("no warnings added", result.source_warnings.length === 0, `got ${result.source_warnings.length}`);
  assert("returns the original object reference (no-op fast path)", result === original);
}

// 3) A mismatch with no clean implied integer is flagged but not "corrected".
{
  console.log("\n▶ flags an unresolvable mismatch without inventing a quantity");
  const result = validateInvoiceArithmetic(
    extraction([
      lineItem({ item_name_normalized: "Beet, Red", quantity: 3, unit_cost: 14.35, line_total: 100.0 })
    ])
  );
  const item = result.line_items[0];
  assert("quantity left as-is", item.quantity === 3, `got ${item.quantity}`);
  assert("confidence capped at 0.7", item.confidence <= 0.7, `got ${item.confidence}`);
  assert("warning present", result.source_warnings.length === 1, `got ${result.source_warnings.length}`);
  assert(
    "warning asks for manual verification",
    result.source_warnings[0].includes("Verify quantity manually"),
    result.source_warnings[0]
  );
}

// 4) Fee lines and lines with null fields are skipped.
{
  console.log("\n▶ skips fees and lines with missing numbers");
  const result = validateInvoiceArithmetic(
    extraction([
      lineItem({ item_name_normalized: "Energy Charge", quantity: 8, unit_cost: 1, line_total: 99, is_fee: true }),
      lineItem({ item_name_normalized: "Lettuce, Special", quantity: null, unit_cost: 12.0, line_total: 96.0 }),
      lineItem({ item_name_normalized: "Cucumber", quantity: 5, unit_cost: null, line_total: 132.25 })
    ])
  );
  assert("no warnings produced", result.source_warnings.length === 0, `got ${result.source_warnings.length}`);
}

// 5) Implausibly large implied quantities are not treated as corrections.
{
  console.log("\n▶ does not 'correct' to an implausibly large case count");
  const result = validateInvoiceArithmetic(
    extraction([
      lineItem({ item_name_normalized: "Mystery Item", quantity: 2, unit_cost: 0.01, line_total: 9.0 })
    ])
  );
  const item = result.line_items[0];
  assert("quantity not replaced by 900", item.quantity === 2, `got ${item.quantity}`);
  assert("notes do not claim an auto-correction", !(item.notes ?? "").includes("auto-corrected"));
}

console.log(`\n${failures === 0 ? "✓" : "✗"} ${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
