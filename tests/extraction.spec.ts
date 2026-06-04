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
}

interface FixtureCase {
  file: string;
  supplierHint: Supplier;
  expect: FixtureExpectations;
}

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
  const mimeType = f.file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
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
