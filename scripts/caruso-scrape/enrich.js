// Read the scraped listing and add derivedWeightLb + kind classification.
// Output: out/caruso-catalog.enriched.json
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const IN = path.join("out", "caruso-listing.json");
const OUT = path.join("out", "caruso-catalog.enriched.json");

// Pack-size grammar we've observed:
//   "25#"          -> 25 lb
//   "12/6 OZ"      -> 12 * 6 / 16 lb
//   "12/3#"        -> 12 * 3 lb
//   "56 CT"        -> weight unknown (needs detail page)
//   "6/200 ML"     -> volume, no weight
//   "24/12.5 GAL"  -> volume
function classify(packRaw) {
  const p = (packRaw ?? "").trim();
  if (!p) return { kind: "unknown", weightLb: null };

  // Plain "25#"
  let m = p.match(/^(\d+(?:\.\d+)?)\s*#$/);
  if (m) return { kind: "lb_direct", weightLb: parseFloat(m[1]) };

  // "12/3#" or "24/2.5#"
  m = p.match(/^(\d+)\s*\/\s*(\d+(?:\.\d+)?)\s*#$/);
  if (m) return { kind: "multi_lb", weightLb: parseInt(m[1], 10) * parseFloat(m[2]) };

  // "12/6 OZ" or "48/.75 OZ"
  m = p.match(/^(\d+)\s*\/\s*(\d*\.?\d+)\s*OZ$/i);
  if (m) return { kind: "multi_oz", weightLb: (parseInt(m[1], 10) * parseFloat(m[2])) / 16 };

  // "8/18 OZ" — same shape, above already catches it. Also handle "12/6OZ" without space.
  m = p.match(/^(\d+)\s*\/\s*(\d*\.?\d+)OZ$/i);
  if (m) return { kind: "multi_oz", weightLb: (parseInt(m[1], 10) * parseFloat(m[2])) / 16 };

  // Single "30 OZ"
  m = p.match(/^(\d*\.?\d+)\s*OZ$/i);
  if (m) return { kind: "single_oz", weightLb: parseFloat(m[1]) / 16 };

  // "56 CT" or "12 CT" or "8/9 CT"
  m = p.match(/^\d+(?:\s*\/\s*\d+)?\s*CT$/i);
  if (m) return { kind: "ct_only", weightLb: null };

  // Volume: "6/200 ML", "12/750 ML", "2/1 GAL", "24/12.5 GAL", "4/4 L"
  if (/\b(ML|GAL|L|LTR|LITER)\b/i.test(p)) return { kind: "volume", weightLb: null };

  // Bins / display / supply / unmatched
  return { kind: "other", weightLb: null };
}

const raw = JSON.parse(await readFile(IN, "utf8"));
const items = raw.items.map((it) => {
  const c = classify(it.packSize);
  return {
    sku: it.sku,
    name: it.name,
    packSize: it.packSize,
    weightLb: c.weightLb !== null ? Math.round(c.weightLb * 1000) / 1000 : null,
    weightSource: c.weightLb !== null ? "derived_from_pack" : null,
    kind: c.kind
  };
});

const stats = items.reduce((acc, it) => { acc[it.kind] = (acc[it.kind] ?? 0) + 1; return acc; }, {});
const derivable = items.filter((i) => i.weightLb !== null).length;

const out = {
  scrapedAt: raw.scrapedAt,
  enrichedAt: new Date().toISOString(),
  totalItems: items.length,
  derivableWeights: derivable,
  needsDetailPage: items.filter((i) => i.kind === "ct_only").length,
  kindStats: stats,
  items
};

await writeFile(OUT, JSON.stringify(out, null, 2), "utf8");
console.log("stats:", stats);
console.log("derivable weights:", derivable, "/", items.length);
console.log("wrote", OUT);
