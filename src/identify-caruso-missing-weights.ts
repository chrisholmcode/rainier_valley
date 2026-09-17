/**
 * Identify Caruso SKUs on recent invoices that landed without a usable weight
 * signal. Used to scope a targeted re-scrape of the Caruso website when their
 * catalog changes and new SKUs appear that our snapshot in
 * `data/caruso-catalog.json` doesn't know about.
 *
 * Read-only. Writes a target-list JSON that
 * `scripts/caruso-scrape/scrape-weights.js --input=...` can consume.
 *
 * Usage:
 *   npx tsx src/identify-caruso-missing-weights.ts [--days=30]
 *
 * Output:
 *   scripts/caruso-scrape/out/rvfb-caruso-skus-missing.json
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { readDeliveryRows } from "./sheets.js";
import { lookupCarusoBySku, normalizeSku } from "./carusoCatalog.js";
import type { DeliverySheetRow } from "./types.js";

function parseArgs(): { days: number } {
  let days = 30;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith("--days=")) days = parseInt(a.slice("--days=".length), 10);
  }
  return { days };
}

function isFee(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.toString().toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

// Same weight rule as the dashboard / audit-inbound-weight-coverage: a row is
// "weighed" if approx_weight > 0, or unit is pounds and quantity > 0.
function hasUsableWeight(r: DeliverySheetRow): boolean {
  const aw = parseFloat(r.approx_weight ?? "");
  if (Number.isFinite(aw) && aw > 0) return true;
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    const q = parseFloat(r.quantity ?? "");
    if (Number.isFinite(q) && q > 0) return true;
  }
  return false;
}

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type Classification = "ct_only" | "missing_from_catalog" | "in_catalog_with_weight";

interface SkuHit {
  sku: string;
  nameOnSlip: string | null;
  occurrences: number;
  classification: Classification;
  catalogName: string | null;
  catalogPackSize: string | null;
}

async function main(): Promise<void> {
  const { days } = parseArgs();
  const cutoff = daysAgoIso(days);
  console.log(`# identify-caruso-missing-weights`);
  console.log(`# window: delivery_date >= ${cutoff} (last ${days} days)`);

  const rows = await readDeliveryRows({ limit: 100_000 });
  const caruso = rows.filter((r) => (r.supplier ?? "").toLowerCase().trim() === "carusos");
  const recent = caruso.filter((r) => {
    if (isFee(r.is_fee)) return false;
    const d = r.delivery_date ?? r.invoice_date ?? "";
    return d >= cutoff;
  });
  const unweighed = recent.filter((r) => !hasUsableWeight(r));
  console.log(
    `rows: total=${rows.length} carusos=${caruso.length} carusos_recent=${recent.length} carusos_recent_unweighed=${unweighed.length}`
  );

  const bySku = new Map<string, SkuHit>();
  let noSkuCount = 0;
  for (const r of unweighed) {
    const sku = normalizeSku(r.item_code_raw);
    if (!sku) {
      noSkuCount += 1;
      continue;
    }
    const existing = bySku.get(sku);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    const cat = lookupCarusoBySku(sku);
    let classification: Classification;
    if (!cat) classification = "missing_from_catalog";
    else if (cat.weightLb == null) classification = "ct_only";
    else classification = "in_catalog_with_weight";
    bySku.set(sku, {
      sku,
      nameOnSlip: r.item_name_raw,
      occurrences: 1,
      classification,
      catalogName: cat?.name ?? null,
      catalogPackSize: cat?.packSize ?? null
    });
  }

  const all = Array.from(bySku.values()).sort((a, b) => b.occurrences - a.occurrences);
  const targets = all.filter(
    (s) => s.classification === "missing_from_catalog" || s.classification === "ct_only"
  );
  const missingFromCatalog = all.filter((s) => s.classification === "missing_from_catalog");
  const ctOnly = all.filter((s) => s.classification === "ct_only");
  const inCatalogWithWeight = all.filter((s) => s.classification === "in_catalog_with_weight");

  console.log(`distinct unweighed SKUs: ${all.length}`);
  console.log(`  missing from catalog (new since last scrape): ${missingFromCatalog.length}`);
  console.log(`  ct_only in catalog (weight never scraped):    ${ctOnly.length}`);
  console.log(`  in catalog with weight (reconcile skipped?):  ${inCatalogWithWeight.length}`);
  console.log(`  rows missing SKU on slip:                     ${noSkuCount}`);
  console.log(`scrape targets: ${targets.length}`);

  const outDir = path.join(process.cwd(), "scripts/caruso-scrape/out");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "rvfb-caruso-skus-missing.json");
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowDays: days,
        cutoffDate: cutoff,
        counts: {
          distinctUnweighedSkus: all.length,
          missingFromCatalog: missingFromCatalog.length,
          ctOnly: ctOnly.length,
          inCatalogWithWeight: inCatalogWithWeight.length,
          rowsMissingSku: noSkuCount,
          scrapeTargets: targets.length
        },
        targetSkus: targets.map((t) => t.sku),
        details: all
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`wrote ${outPath}`);

  if (inCatalogWithWeight.length > 0) {
    console.log(
      `\nnote: ${inCatalogWithWeight.length} SKU(s) have a weight in the catalog but weren't reconciled onto the row — likely older rows written before Caruso reconcile shipped, or extraction didn't emit a matching item_code_raw. Not included in scrape targets.`
    );
  }
}

main().catch((err) => {
  console.error("identify failed:", (err as Error).message);
  process.exit(1);
});
