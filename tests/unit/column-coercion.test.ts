import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coerceForColumn } from "../../src/sheets.js";

describe("coerceForColumn", () => {
  describe("numeric columns", () => {
    for (const col of ["quantity_ordered", "quantity", "approx_weight", "unit_cost", "line_total", "confidence"]) {
      it(`coerces integer strings to number for "${col}"`, () => {
        assert.equal(coerceForColumn(col, "42"), 42);
      });
      it(`coerces decimal strings to number for "${col}"`, () => {
        assert.equal(coerceForColumn(col, "12.5"), 12.5);
      });
      it(`leaves already-numeric values alone for "${col}"`, () => {
        assert.equal(coerceForColumn(col, 42), 42);
        assert.equal(coerceForColumn(col, 12.5), 12.5);
      });
      it(`falls back to string for unparseable input on "${col}"`, () => {
        assert.equal(coerceForColumn(col, "abc"), "abc");
      });
      it(`treats trimmable whitespace as empty for "${col}"`, () => {
        assert.equal(coerceForColumn(col, "   "), null);
        assert.equal(coerceForColumn(col, ""), null);
      });
    }
  });

  describe("boolean columns", () => {
    for (const col of ["is_fee", "is_donation", "donor_anonymous", "send_receipt", "is_food_drive", "is_food"]) {
      it(`coerces "true" variants to true on "${col}"`, () => {
        assert.equal(coerceForColumn(col, "true"), true);
        assert.equal(coerceForColumn(col, "TRUE"), true);
        assert.equal(coerceForColumn(col, "True"), true);
        assert.equal(coerceForColumn(col, "1"), true);
        assert.equal(coerceForColumn(col, "yes"), true);
      });
      it(`coerces "false" variants to false on "${col}"`, () => {
        assert.equal(coerceForColumn(col, "false"), false);
        assert.equal(coerceForColumn(col, "FALSE"), false);
        assert.equal(coerceForColumn(col, "0"), false);
        assert.equal(coerceForColumn(col, "no"), false);
      });
      it(`falls back to string on unparseable boolean input on "${col}"`, () => {
        assert.equal(coerceForColumn(col, "maybe"), "maybe");
      });
    }
  });

  describe("other columns (pass-through as text)", () => {
    it("leaves free-text columns alone", () => {
      assert.equal(coerceForColumn("notes", "some note"), "some note");
      assert.equal(coerceForColumn("item_name_raw", "Bakery"), "Bakery");
    });
    it("does NOT coerce numeric-looking strings on non-numeric columns", () => {
      // The whole point of the RAW-write flip — identifier columns must not
      // become numbers.
      assert.equal(coerceForColumn("invoice_or_order_number", "545488"), "545488");
      assert.equal(coerceForColumn("item_code_raw", "00683"), "00683");
      assert.equal(coerceForColumn("slack_message_ts", "1774402424.988810"), "1774402424.988810");
    });
    it("trims and returns null for empty text", () => {
      assert.equal(coerceForColumn("notes", ""), null);
      assert.equal(coerceForColumn("notes", "   "), null);
    });
  });

  describe("null handling", () => {
    it("returns null for null input on any column", () => {
      assert.equal(coerceForColumn("quantity", null), null);
      assert.equal(coerceForColumn("is_fee", null), null);
      assert.equal(coerceForColumn("notes", null), null);
    });
    it("passes through pre-typed non-string values on numeric columns", () => {
      assert.equal(coerceForColumn("quantity", true), true);
      assert.equal(coerceForColumn("quantity", false), false);
    });
  });
});
