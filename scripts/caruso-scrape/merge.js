// Merge scraped Net Weights into caruso-catalog.enriched.json → data/caruso-catalog.json
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ENRICHED = path.join("out", "caruso-catalog.enriched.json");
const WEIGHTS = path.join("out", "caruso-weights.json");
const OUT = path.join("..", "..", "data", "caruso-catalog.json");

const catalog = JSON.parse(await readFile(ENRICHED, "utf8"));
const weights = JSON.parse(await readFile(WEIGHTS, "utf8"));

const weightBySku = new Map();
for (const w of weights.results) {
  if (w.ok && w.weightLb != null) weightBySku.set(w.sku, w);
}

let updated = 0;
for (const it of catalog.items) {
  const w = weightBySku.get(it.sku);
  if (w && it.weightLb == null) {
    it.weightLb = w.weightLb;
    it.weightSource = "scraped_detail";
    updated++;
  }
}

catalog.mergedAt = new Date().toISOString();
catalog.scrapedWeightCount = updated;
catalog.totalWithWeight = catalog.items.filter((i) => i.weightLb != null).length;
catalog.needsDetailPage = catalog.items.filter((i) => i.kind === "ct_only" && i.weightLb == null).length;

await writeFile(OUT, JSON.stringify(catalog, null, 2), "utf8");
console.log(`merged ${updated} scraped weights`);
console.log(`total items with weight: ${catalog.totalWithWeight} / ${catalog.items.length}`);
console.log(`remaining ct_only w/o weight: ${catalog.needsDetailPage}`);
console.log(`wrote ${OUT}`);
