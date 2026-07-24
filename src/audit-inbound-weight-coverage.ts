/**
 * Diagnostic: which suppliers most often ship rows without a usable weight
 * signal? Reads the Inbound Delivery Log, applies the same weight rule the
 * dashboard uses (approx_weight > 0, else quantity when unit=lb, else null),
 * and prints a per-supplier report. Read-only — no writes.
 *
 * Usage:
 *   npx tsx src/audit-inbound-weight-coverage.ts [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N]
 *
 *   --from / --to  optional delivery_date window (inclusive). Defaults to all rows.
 *   --limit        row cap when reading the sheet (default: 20000).
 */
import { readDeliveryRows } from "./sheets.js";
import type { DeliverySheetRow } from "./types.js";

function parseArgs(): { from?: string; to?: string; limit: number } {
  const args = process.argv.slice(2);
  let from: string | undefined;
  let to: string | undefined;
  let limit = 20000;
  for (const a of args) {
    if (a.startsWith("--from=")) from = a.slice("--from=".length);
    else if (a.startsWith("--to=")) to = a.slice("--to=".length);
    else if (a.startsWith("--limit=")) limit = parseInt(a.slice("--limit=".length), 10);
  }
  return { from, to, limit };
}

function toNumber(v: string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function isFee(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.toString().toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

// Same rule as src/dashboard.ts inboundPoundsFor — keep in sync.
function rowPounds(r: DeliverySheetRow): number | null {
  const aw = toNumber(r.approx_weight);
  if (aw > 0) return aw;
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    const q = toNumber(r.quantity);
    if (q > 0) return q;
  }
  return null;
}

interface SupplierStats {
  supplier: string;
  total: number;
  weighed: number;
  unweighed: number;
  poundsSum: number;
  unweighedItems: Map<string, number>;
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(0)}%`;
}

function topItems(m: Map<string, number>, n: number): Array<[string, number]> {
  return Array.from(m.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

async function main(): Promise<void> {
  const { from, to, limit } = parseArgs();
  console.log(`# Inbound weight coverage audit`);
  console.log(`# window: ${from ?? "(open)"} → ${to ?? "(open)"} · row limit: ${limit}`);
  console.log(``);

  const rows = await readDeliveryRows({ limit });
  const filtered = rows.filter((r) => {
    if (isFee(r.is_fee)) return false;
    if (from && (!r.delivery_date || r.delivery_date < from)) return false;
    if (to && (!r.delivery_date || r.delivery_date > to)) return false;
    return true;
  });

  const bySupplier = new Map<string, SupplierStats>();
  for (const r of filtered) {
    const supplier = (r.supplier || "(unknown)").trim() || "(unknown)";
    let s = bySupplier.get(supplier);
    if (!s) {
      s = { supplier, total: 0, weighed: 0, unweighed: 0, poundsSum: 0, unweighedItems: new Map() };
      bySupplier.set(supplier, s);
    }
    s.total += 1;
    const lbs = rowPounds(r);
    if (lbs != null) {
      s.weighed += 1;
      s.poundsSum += lbs;
    } else {
      s.unweighed += 1;
      const name = (r.item_name_normalized || r.item_name_raw || "(no item name)").trim() || "(no item name)";
      s.unweighedItems.set(name, (s.unweighedItems.get(name) ?? 0) + 1);
    }
  }

  const grandTotal = filtered.length;
  const grandWeighed = filtered.reduce((s, r) => s + (rowPounds(r) != null ? 1 : 0), 0);
  const grandUnweighed = grandTotal - grandWeighed;

  console.log(`Overall: ${grandTotal} non-fee rows, ${grandWeighed} weighed (${pct(grandWeighed, grandTotal)}), ${grandUnweighed} unweighed.`);
  console.log(``);
  console.log(`## Per supplier (sorted by unweighed row count desc)`);
  console.log(``);
  console.log(`| supplier | total | weighed | unweighed | coverage | pounds |`);
  console.log(`| --- | ---: | ---: | ---: | ---: | ---: |`);

  const sorted = Array.from(bySupplier.values()).sort((a, b) => b.unweighed - a.unweighed);
  for (const s of sorted) {
    console.log(`| ${s.supplier} | ${s.total} | ${s.weighed} | ${s.unweighed} | ${pct(s.weighed, s.total)} | ${Math.round(s.poundsSum)} |`);
  }

  console.log(``);
  console.log(`## Top unweighed items per supplier (up to 5 each, only suppliers with ≥1 unweighed row)`);
  console.log(``);
  for (const s of sorted) {
    if (s.unweighed === 0) continue;
    console.log(`### ${s.supplier} — ${s.unweighed} unweighed rows`);
    for (const [name, count] of topItems(s.unweighedItems, 5)) {
      console.log(`  - ${name} × ${count}`);
    }
    console.log(``);
  }
}

main().catch((err) => {
  console.error("audit failed:", (err as Error).message);
  process.exit(1);
});
