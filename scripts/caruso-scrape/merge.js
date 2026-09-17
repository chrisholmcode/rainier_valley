// Merge scraped Net Weights into data/caruso-catalog.json.
//
// Two update modes, both handled here:
//   1. existing catalog item, weightLb == null → fill in scraped weight
//   2. brand-new SKU (missing from catalog) → append a new item (kind derived
//      from packSize the same way enrich.js classify() does)
//
// Flags:
//   --input=<path>      catalog to merge into. Defaults to the output path
//                       (round-trip through the live catalog — safe for
//                       targeted refreshes). Pass out/caruso-catalog.enriched.json
//                       after a full-catalog rescrape.
//   --weights=<path>    defaults to out/caruso-weights.json
//   --output=<path>     defaults to ../../data/caruso-catalog.json
//   --dry-run           print what would change; don't write
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,
    weights: path.join("out", "caruso-weights.json"),
    output: path.join("..", "..", "data", "caruso-catalog.json"),
    dryRun: false
  };
  for (const a of args) {
    if (a.startsWith("--input=")) opts.input = a.slice("--input=".length);
    else if (a.startsWith("--weights=")) opts.weights = a.slice("--weights=".length);
    else if (a.startsWith("--output=")) opts.output = a.slice("--output=".length);
    else if (a === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

// Mirror of enrich.js `classify()` — kept in sync deliberately so a
// mid-cycle merge doesn't have to shell out to enrich for one new SKU.
function classifyPack(packRaw) {
  const p = (packRaw ?? "").trim();
  if (!p) return { kind: "unknown", weightLb: null };
  let m = p.match(/^(\d+(?:\.\d+)?)\s*#$/);
  if (m) return { kind: "lb_direct", weightLb: parseFloat(m[1]) };
  m = p.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*#$/);
  if (m) return { kind: "multi_lb", weightLb: parseInt(m[1], 10) * parseFloat(m[2]) };
  m = p.match(/^(\d+)\s*\/\s*(\d*\.?\d+)\s*OZ$/i);
  if (m) return { kind: "multi_oz", weightLb: (parseInt(m[1], 10) * parseFloat(m[2])) / 16 };
  m = p.match(/^(\d+)\s*\/\s*(\d*\.?\d+)OZ$/i);
  if (m) return { kind: "multi_oz", weightLb: (parseInt(m[1], 10) * parseFloat(m[2])) / 16 };
  m = p.match(/^(\d*\.?\d+)\s*OZ$/i);
  if (m) return { kind: "single_oz", weightLb: parseFloat(m[1]) / 16 };
  m = p.match(/^\d+(?:\s*\/\s*\d+)?\s*CT$/i);
  if (m) return { kind: "ct_only", weightLb: null };
  if (/\b(ML|GAL|L|LTR|LITER)\b/i.test(p)) return { kind: "volume", weightLb: null };
  return { kind: "other", weightLb: null };
}

const opts = parseArgs();
const INPUT = opts.input ?? opts.output;
const WEIGHTS = opts.weights;
const OUT = opts.output;

console.log(`input:   ${INPUT}`);
console.log(`weights: ${WEIGHTS}`);
console.log(`output:  ${OUT}${opts.dryRun ? " (dry-run)" : ""}`);

const catalog = JSON.parse(await readFile(INPUT, "utf8"));
const weights = JSON.parse(await readFile(WEIGHTS, "utf8"));

const bySkuInCatalog = new Map(catalog.items.map((it) => [it.sku, it]));

let filled = 0;
let added = 0;
let alreadyWeighed = 0;
let scrapeReturnedNoWeight = 0;
const additions = [];
const failures = [];

for (const w of weights.results) {
  if (!w.ok) {
    failures.push({ sku: w.sku, reason: w.reason ?? "unknown" });
    continue;
  }
  const existing = bySkuInCatalog.get(w.sku);
  if (existing) {
    if (w.weightLb == null) {
      scrapeReturnedNoWeight++;
      failures.push({ sku: w.sku, reason: "detail page had no Net Weight" });
    } else if (existing.weightLb == null) {
      existing.weightLb = w.weightLb;
      existing.weightSource = "scraped_detail";
      filled++;
    } else {
      alreadyWeighed++;
    }
    continue;
  }
  // Brand-new SKU. Derive kind from packSize if we captured it; else fall back
  // to "unknown" (kind isn't load-bearing for reconciliation — weightLb is).
  const c = classifyPack(w.packSize);
  const item = {
    sku: w.sku,
    name: w.name ?? null,
    packSize: w.packSize ?? null,
    weightLb: w.weightLb != null ? w.weightLb : c.weightLb,
    weightSource: w.weightLb != null ? "scraped_detail" : (c.weightLb != null ? "derived_from_pack" : null),
    kind: c.kind
  };
  catalog.items.push(item);
  bySkuInCatalog.set(w.sku, item);
  additions.push(item);
  added++;
}

catalog.items.sort((a, b) => a.sku.localeCompare(b.sku));
catalog.mergedAt = new Date().toISOString();
catalog.totalItems = catalog.items.length;
catalog.totalWithWeight = catalog.items.filter((i) => i.weightLb != null).length;
catalog.needsDetailPage = catalog.items.filter((i) => i.kind === "ct_only" && i.weightLb == null).length;
catalog.lastMergeStats = { filled, added, alreadyWeighed, scrapeReturnedNoWeight, failed: failures.length };

if (!opts.dryRun) {
  await writeFile(OUT, JSON.stringify(catalog, null, 2), "utf8");
}

console.log(`\nresults:`);
console.log(`  filled weights on existing catalog items:    ${filled}`);
console.log(`  added brand-new catalog items:               ${added}`);
console.log(`  already had weight (no change):              ${alreadyWeighed}`);
console.log(`  detail page missing Net Weight (no fill):    ${scrapeReturnedNoWeight}`);
console.log(`  scrape failures (nav/card not found):        ${failures.length - scrapeReturnedNoWeight}`);
console.log(`  total items now: ${catalog.totalItems} (with weight: ${catalog.totalWithWeight})`);
console.log(`  remaining ct_only w/o weight: ${catalog.needsDetailPage}`);
if (additions.length > 0) {
  console.log(`\nadded SKUs:`);
  for (const it of additions) {
    console.log(`  ${it.sku}  ${it.weightLb ?? "?"} lb  ${it.kind.padEnd(10)}  ${it.packSize ?? "(no pack)"}  ${it.name ?? "(no name)"}`);
  }
}
if (failures.length > 0) {
  console.log(`\nfailed / no-weight SKUs (rerun or fill manually):`);
  for (const f of failures) console.log(`  ${f.sku}  ${f.reason}`);
}
if (opts.dryRun) console.log(`\n(dry-run — no file written)`);
else console.log(`\nwrote ${OUT}`);
