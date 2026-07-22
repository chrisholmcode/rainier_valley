import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guessSupplierFromFilename } from "../../src/extraction.js";

describe("guessSupplierFromFilename", () => {
  it("recognizes each supplier from filename keywords", () => {
    assert.equal(guessSupplierFromFilename("caruso_20260722.jpg"), "carusos");
    assert.equal(guessSupplierFromFilename("charlies_produce.pdf"), "charlies");
    assert.equal(guessSupplierFromFilename("costco_business.jpg"), "costco");
    assert.equal(guessSupplierFromFilename("grand_central_202607.pdf"), "grand_central");
    assert.equal(guessSupplierFromFilename("gcb_invoice.pdf"), "grand_central");
    assert.equal(guessSupplierFromFilename("harvest_manifest.pdf"), "nw_harvest");
    assert.equal(guessSupplierFromFilename("pacific_ship.jpg"), "pacific");
    assert.equal(guessSupplierFromFilename("pfd_bol.pdf"), "pacific");
    assert.equal(guessSupplierFromFilename("terrebonne_137.jpg"), "terrebonne");
    assert.equal(guessSupplierFromFilename("truckpatch_202607.jpg"), "terrebonne");
    assert.equal(guessSupplierFromFilename("weigelt_65315.pdf"), "weigelt");
  });

  it("routes Food Lifeline filenames to 'unknown' — LLM decides between food_lifeline vs grocery_rescue subtypes", () => {
    // After PR #44, filename can't distinguish AGENCY ORDER (food_lifeline)
    // from handwritten rescue (grocery_rescue). Both use "Food Lifeline" branding.
    assert.equal(guessSupplierFromFilename("food_lifeline_202607.jpg"), "unknown");
    assert.equal(guessSupplierFromFilename("foodlifeline_manifest.pdf"), "unknown");
    assert.equal(guessSupplierFromFilename("food lifeline slip.jpg"), "unknown");
    assert.equal(guessSupplierFromFilename("lifeline_agency_order.pdf"), "unknown");
  });

  it("recognizes 'rescue' hint as grocery_rescue", () => {
    assert.equal(guessSupplierFromFilename("grocery_rescue_swy-rb.jpg"), "grocery_rescue");
    assert.equal(guessSupplierFromFilename("grocery-rescue-2026.jpg"), "grocery_rescue");
    assert.equal(guessSupplierFromFilename("rescue_qfc_mi.jpg"), "grocery_rescue");
  });

  it("returns 'unknown' for unrecognized filenames", () => {
    assert.equal(guessSupplierFromFilename("random.jpg"), "unknown");
    assert.equal(guessSupplierFromFilename(""), "unknown");
    assert.equal(guessSupplierFromFilename("IMG_1234.jpg"), "unknown");
  });

  it("is case-insensitive", () => {
    assert.equal(guessSupplierFromFilename("CARUSO.JPG"), "carusos");
    assert.equal(guessSupplierFromFilename("Weigelt.PDF"), "weigelt");
  });
});
