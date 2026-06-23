/**
 * Extraction eval harness.
 *
 * For each entry in FIXTURES, runs the real `extractFromImage` against a
 * pinned fixture image and asserts the structural facts we care about
 * (supplier, line-item count, fee presence, specific raw item names, etc.).
 *
 * Cheap to add a new fixture — copy the pattern below and point at any
 * file in tests/fixtures/. Keep assertions about what STRUCTURALLY must
 * be true; don't pin individual quantities or normalized names that
 * may drift between model versions.
 *
 * Run: `npm run test`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFromImage } from "../src/extraction.js";
import type { Supplier } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

interface FixtureExpectations {
  supplier: Supplier;
  document_type: string;
  minLineItems: number;
  feesCount: number;
  feeDescriptionContains?: string[];
  itemNameRawContainsAny?: string[];
  itemNameRawContainsAll?: string[];
  requireTotalsPresent?: Array<"subtotal" | "tax" | "grand_total">;
  isDonation?: boolean;
  donorOrgContains?: string;
}

interface FixtureCase {
  file: string;
  supplierHint: Supplier;
  expect: FixtureExpectations;
}

// IMG_2712 (NW Harvest pallet label) and IMG_2720 (stacked papers) are
// intentionally not yet covered — both are edge cases where the model's
// classification isn't structurally pinnable from the photo alone. Add
// them after running once and observing the actual output.
const FIXTURES: FixtureCase[] = [
  {
    file: "tests/fixtures/IMG_2718.jpg",
    supplierHint: "carusos",
    expect: {
      supplier: "carusos",
      document_type: "invoice",
      minLineItems: 8,
      feesCount: 1,
      feeDescriptionContains: ["FUEL SURCHARGE"],
      itemNameRawContainsAny: ["BERRIES BLACK", "TOMATO ROMA", "NECTARINE"],
      requireTotalsPresent: ["subtotal", "grand_total"]
    }
  },
  {
    file: "tests/fixtures/IMG_2719.jpg",
    supplierHint: "nw_harvest",
    expect: {
      supplier: "nw_harvest",
      document_type: "warehouse_posted_shipment",
      minLineItems: 8,
      feesCount: 0,
      itemNameRawContainsAny: ["Rice", "Potatoes", "Onions", "Bread"]
    }
  },
  {
    file: "tests/fixtures/nw_harvest_IMG_4043.jpg",
    supplierHint: "nw_harvest",
    expect: {
      supplier: "nw_harvest",
      document_type: "warehouse_posted_shipment",
      minLineItems: 6,
      feesCount: 0,
      itemNameRawContainsAny: ["Rice", "Squash", "Chicken", "Cookies"]
    }
  },
  {
    file: "tests/fixtures/IMG_2721.jpg",
    supplierHint: "charlies",
    expect: {
      supplier: "charlies",
      document_type: "invoice",
      minLineItems: 5,
      feesCount: 1,
      feeDescriptionContains: ["ENERGY"],
      itemNameRawContainsAny: ["AVOCADO", "CUCUMBER", "LETTUCE", "PEPPER"],
      requireTotalsPresent: ["grand_total"]
    }
  },
  {
    file: "tests/fixtures/Costco_Invoice_1292264544.pdf",
    supplierHint: "costco",
    expect: {
      supplier: "costco",
      document_type: "invoice",
      minLineItems: 4,
      feesCount: 0,
      itemNameRawContainsAny: ["GRANOLA", "RAMEN", "GOGO SQUEEZ", "OATMEAL"],
      requireTotalsPresent: ["subtotal", "grand_total"],
      isDonation: false
    }
  },
  {
    file: "tests/fixtures/grand_central_IMG_4042.jpg",
    supplierHint: "grand_central",
    expect: {
      supplier: "grand_central",
      document_type: "invoice",
      minLineItems: 1,
      feesCount: 0,
      itemNameRawContainsAny: ["COMMUNITY LOAF", "LOAF"],
      requireTotalsPresent: ["grand_total"],
      isDonation: true
    }
  },
  {
    file: "tests/fixtures/food_lifeline_IMG_4041.jpg",
    supplierHint: "food_lifeline",
    expect: {
      supplier: "food_lifeline",
      document_type: "manifest",
      minLineItems: 7,
      feesCount: 0,
      itemNameRawContainsAny: ["Bok Choy", "Chicken Drumsticks", "Peanut Butter", "Pears", "Grapefruit"],
      isDonation: true
    }
  },
  {
    file: "tests/fixtures/terrebonne_IMG_4045.jpg",
    supplierHint: "terrebonne",
    expect: {
      supplier: "terrebonne",
      document_type: "invoice",
      minLineItems: 2,
      feesCount: 0,
      itemNameRawContainsAny: ["green leaf", "Radish", "Heads", "bunch"],
      requireTotalsPresent: ["grand_total"],
      isDonation: false
    }
  },
  {
    file: "tests/fixtures/food_lifeline_rescue_qfc_IMG_4047.jpg",
    supplierHint: "food_lifeline",
    expect: {
      supplier: "food_lifeline",
      document_type: "manifest",
      minLineItems: 4,
      feesCount: 0,
      itemNameRawContainsAny: ["Bakery", "Meat", "Dairy", "Prepared"],
      isDonation: true,
      donorOrgContains: "QFC"
    }
  },
  {
    file: "tests/fixtures/food_lifeline_rescue_safeway_IMG_4046.jpg",
    supplierHint: "food_lifeline",
    expect: {
      supplier: "food_lifeline",
      document_type: "manifest",
      minLineItems: 4,
      feesCount: 0,
      itemNameRawContainsAny: ["Bakery", "Meat", "Dairy", "Produce"],
      isDonation: true,
      donorOrgContains: "Safeway"
    }
  }
];

interface CheckResult { name: string; pass: boolean; detail: string; }

function check(name: string, pass: boolean, detail = ""): CheckResult {
  return { name, pass, detail };
}

function containsAny(haystack: string[], needles: string[]): string | null {
  for (const needle of needles) {
    if (haystack.some((h) => h.toUpperCase().includes(needle.toUpperCase()))) return needle;
  }
  return null;
}

async function runFixture(f: FixtureCase): Promise<CheckResult[]> {
  const fullPath = join(REPO_ROOT, f.file);
  const bytes = readFileSync(fullPath);
  const lower = f.file.toLowerCase();
  const mimeType = lower.endsWith(".pdf")
    ? "application/pdf"
    : lower.endsWith(".png")
    ? "image/png"
    : "image/jpeg";
  const filename = f.file.split("/").pop() ?? f.file;

  console.log(`\n▶ ${f.file}`);
  const start = Date.now();
  const result = await extractFromImage({
    imageBytes: bytes,
    mimeType,
    filename,
    supplierHint: f.supplierHint
  });
  console.log(`  extracted in ${((Date.now() - start) / 1000).toFixed(1)}s — ${result.line_items.length} items, ${result.fees.length} fees`);

  const checks: CheckResult[] = [];
  checks.push(check(`supplier === "${f.expect.supplier}"`, result.supplier === f.expect.supplier, `got "${result.supplier}"`));
  checks.push(check(`document_type === "${f.expect.document_type}"`, result.document_type === f.expect.document_type, `got "${result.document_type}"`));
  checks.push(check(`line_items.length >= ${f.expect.minLineItems}`, result.line_items.length >= f.expect.minLineItems, `got ${result.line_items.length}`));
  checks.push(check(`fees.length === ${f.expect.feesCount}`, result.fees.length === f.expect.feesCount, `got ${result.fees.length}`));

  if (f.expect.feeDescriptionContains) {
    const descs = result.fees.map((fee) => fee.description);
    for (const needle of f.expect.feeDescriptionContains) {
      const found = descs.some((d) => d.toUpperCase().includes(needle.toUpperCase()));
      checks.push(check(`fee description contains "${needle}"`, found, `descriptions: [${descs.join(", ")}]`));
    }
  }

  const rawNames = result.line_items.map((li) => li.item_name_raw ?? "");

  if (f.expect.itemNameRawContainsAny) {
    const matched = containsAny(rawNames, f.expect.itemNameRawContainsAny);
    checks.push(check(
      `at least one item_name_raw contains any of [${f.expect.itemNameRawContainsAny.join(", ")}]`,
      matched !== null,
      `matched: ${matched ?? "(none)"}`
    ));
  }

  if (f.expect.itemNameRawContainsAll) {
    for (const needle of f.expect.itemNameRawContainsAll) {
      const found = rawNames.some((n) => n.toUpperCase().includes(needle.toUpperCase()));
      checks.push(check(`item_name_raw contains "${needle}"`, found));
    }
  }

  if (f.expect.requireTotalsPresent) {
    for (const key of f.expect.requireTotalsPresent) {
      const v = result.totals[key];
      checks.push(check(`totals.${key} is non-null`, v !== null, `got ${v}`));
    }
  }

  if (typeof f.expect.isDonation === "boolean") {
    checks.push(check(
      `is_donation === ${f.expect.isDonation}`,
      result.is_donation === f.expect.isDonation,
      `got ${result.is_donation}`
    ));
  }

  if (f.expect.donorOrgContains) {
    const donor = result.donor_org ?? "";
    checks.push(check(
      `donor_org contains "${f.expect.donorOrgContains}"`,
      donor.toUpperCase().includes(f.expect.donorOrgContains.toUpperCase()),
      `got "${donor}"`
    ));
  }

  return checks;
}

async function main(): Promise<void> {
  let totalFail = 0;
  let totalPass = 0;

  for (const fixture of FIXTURES) {
    try {
      const results = await runFixture(fixture);
      for (const r of results) {
        const mark = r.pass ? "✓" : "✗";
        const detail = r.detail && !r.pass ? ` — ${r.detail}` : "";
        console.log(`  ${mark} ${r.name}${detail}`);
        if (r.pass) totalPass++;
        else totalFail++;
      }
    } catch (error) {
      console.error(`  ✗ ${fixture.file} threw: ${(error as Error).message}`);
      totalFail++;
    }
  }

  console.log(`\n${totalFail === 0 ? "✓" : "✗"} ${totalPass} passed, ${totalFail} failed`);
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
