/**
 * Enumerate distinct Caruso SKUs that have appeared on RVFB invoices.
 * Used to scope the CT-only weight scrape to what RVFB actually orders.
 *
 * Usage: tsx src/dump-caruso-skus.ts
 * Output: scripts/caruso-scrape/out/rvfb-caruso-skus.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readDeliveryRows } from "./sheets.js";
import { lookupCarusoBySku, normalizeSku } from "./carusoCatalog.js";

async function main() {
  const rows = await readDeliveryRows({ limit: 100_000 });
  const caruso = rows.filter((r) => (r.supplier ?? "").toLowerCase().trim() === "carusos");
  console.log(`total rows=${rows.length} carusos rows=${caruso.length}`);

  const seen = new Map<string, { sku: string; nameOnSlip: string | null; occurrences: number; catalogHit: boolean; catalogKind: string | null }>();
  for (const r of caruso) {
    const sku = normalizeSku(r.item_code_raw);
    if (!sku) continue;
    const cur = seen.get(sku);
    if (cur) { cur.occurrences++; continue; }
    const cat = lookupCarusoBySku(sku);
    seen.set(sku, {
      sku,
      nameOnSlip: r.item_name_raw,
      occurrences: 1,
      catalogHit: !!cat,
      catalogKind: cat?.kind ?? null
    });
  }

  const skus = Array.from(seen.values()).sort((a, b) => b.occurrences - a.occurrences);
  const ctOnly = skus.filter((s) => s.catalogKind === "ct_only");
  const miss = skus.filter((s) => !s.catalogHit);

  console.log(`distinct SKUs: ${skus.length}`);
  console.log(`  catalog hits: ${skus.length - miss.length}`);
  console.log(`  catalog miss: ${miss.length}`);
  console.log(`  ct_only (needs weight scrape): ${ctOnly.length}`);

  const outDir = path.join(process.cwd(), "scripts/caruso-scrape/out");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "rvfb-caruso-skus.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalDistinctSkus: skus.length,
        catalogHits: skus.length - miss.length,
        catalogMisses: miss.length,
        ctOnlyCount: ctOnly.length,
        ctOnlySkus: ctOnly.map((s) => s.sku),
        skus
      },
      null,
      2
    ),
    "utf8"
  );
  console.log("wrote", outPath);
}

main().catch((err) => { console.error(err); process.exit(1); });
