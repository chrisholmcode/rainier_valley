import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rescueDedupeKey } from "../../src/sheets.js";

describe("rescueDedupeKey", () => {
  it("builds the key for grocery_rescue slips", () => {
    assert.equal(
      rescueDedupeKey("grocery_rescue", "SWY-RB", "2026-07-22"),
      "grocery_rescue:swy-rb:2026-07-22"
    );
  });

  it("accepts the legacy food_lifeline supplier (backward compat until backfill)", () => {
    assert.equal(
      rescueDedupeKey("food_lifeline", "QFC-MI", "2026-07-15"),
      "grocery_rescue:qfc-mi:2026-07-15"
    );
  });

  it("returns null on non-rescue suppliers", () => {
    assert.equal(rescueDedupeKey("carusos", "SWY-RB", "2026-07-22"), null);
    assert.equal(rescueDedupeKey("charlies", "SWY-RB", "2026-07-22"), null);
    assert.equal(rescueDedupeKey("nw_harvest", "SWY-RB", "2026-07-22"), null);
  });

  it("returns null when any component is missing", () => {
    assert.equal(rescueDedupeKey(null, "SWY-RB", "2026-07-22"), null);
    assert.equal(rescueDedupeKey("grocery_rescue", null, "2026-07-22"), null);
    assert.equal(rescueDedupeKey("grocery_rescue", "SWY-RB", null), null);
    assert.equal(rescueDedupeKey("grocery_rescue", "", "2026-07-22"), null);
    assert.equal(rescueDedupeKey("grocery_rescue", "   ", "2026-07-22"), null);
  });

  it("normalizes donor casing + whitespace", () => {
    // Confirms the same slip written with different donor casings still dedupes.
    const a = rescueDedupeKey("grocery_rescue", "SWY-RB", "2026-07-22");
    const b = rescueDedupeKey("grocery_rescue", "swy-rb", "2026-07-22");
    const c = rescueDedupeKey("grocery_rescue", "  SWY-RB  ", "2026-07-22");
    assert.equal(a, b);
    assert.equal(a, c);
  });
});
