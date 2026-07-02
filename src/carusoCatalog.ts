import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { ExtractionResult } from "./types.js";

export type CarusoCatalogItem = {
  sku: string;
  name: string | null;
  packSize: string | null;
  weightLb: number | null;
  weightSource: "derived_from_pack" | "scraped_detail" | null;
  kind: "lb_direct" | "multi_lb" | "multi_oz" | "single_oz" | "ct_only" | "volume" | "other" | "unknown";
};

type CatalogFile = {
  scrapedAt: string;
  enrichedAt: string;
  totalItems: number;
  items: CarusoCatalogItem[];
};

const CATALOG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "caruso-catalog.json"
);

let cache: Map<string, CarusoCatalogItem> | null = null;

function load(): Map<string, CarusoCatalogItem> {
  if (cache) return cache;
  const raw = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogFile;
  cache = new Map();
  for (const it of raw.items) cache.set(normalizeSku(it.sku), it);
  return cache;
}

// SKUs on slips may be OCR'd without leading zeros ("683" vs "00683") or with an
// apostrophe prefix from Sheets ("'00683"). Normalize to a leading-zero 5-digit form.
export function normalizeSku(v: string | null | undefined): string {
  if (v == null) return "";
  const s = String(v).trim().replace(/^'/, "");
  if (!s) return "";
  const digits = s.replace(/[^0-9]/g, "");
  if (!digits) return s;
  return digits.padStart(5, "0");
}

export function lookupCarusoBySku(sku: string | null | undefined): CarusoCatalogItem | null {
  const key = normalizeSku(sku);
  if (!key) return null;
  return load().get(key) ?? null;
}

// Post-extraction reconciliation: when the supplier is Caruso and a line item's
// SKU hits the catalog, overwrite approx_weight with the catalog value (it's
// authoritative for stable pack sizes and RVFB has ~50% catalog hit rate on
// historical invoices). Extracted weight is preserved in the notes column so
// reviewers can see what changed. No-op for non-Caruso extractions.
export function reconcileWithCarusoCatalog(extraction: ExtractionResult): {
  hits: number;
  overwrites: number;
} {
  if (extraction.supplier !== "carusos") return { hits: 0, overwrites: 0 };
  let hits = 0;
  let overwrites = 0;
  for (const item of extraction.line_items) {
    const cat = lookupCarusoBySku(item.item_code_raw);
    if (!cat) continue;
    hits++;
    if (cat.weightLb == null) continue;
    if (item.approx_weight !== cat.weightLb) {
      const prevNote = item.notes ? `${item.notes} ` : "";
      const prevWeight = item.approx_weight != null ? `${item.approx_weight}` : "null";
      item.notes = `${prevNote}[catalog: weight ${prevWeight}→${cat.weightLb} lb; sku ${cat.sku} ${cat.name}]`;
      item.approx_weight = cat.weightLb;
      overwrites++;
    }
  }
  if (hits > 0) {
    extraction.source_warnings.push(
      `Reconciled ${hits} line item(s) against Caruso catalog (${overwrites} weight overwrite${overwrites === 1 ? "" : "s"}).`
    );
  }
  return { hits, overwrites };
}

export function catalogStats(): { total: number; withWeight: number; ctOnly: number } {
  const m = load();
  let withWeight = 0;
  let ctOnly = 0;
  for (const it of m.values()) {
    if (it.weightLb != null) withWeight++;
    if (it.kind === "ct_only") ctOnly++;
  }
  return { total: m.size, withWeight, ctOnly };
}
