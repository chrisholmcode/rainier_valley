/**
 * One-off: walk every (supplier, invoice_or_order_number) group in the Inbound
 * Delivery Log and call recomputeSummaryForSlip on it. Fixes:
 *   - Missing summary rows (delivery groups that never got one because the slip
 *     was low-conf on ingest and no reviewer edits fired recompute).
 *   - Stale weight_lb / cost / food_type from prior extractions.
 *
 * Does NOT touch orphan summary rows (summary rows with no matching delivery
 * group) — that's a separate cleanup pass.
 *
 * Skips slips where (supplier, invoice_or_order_number) can't uniquely identify
 * a shipment (empty supplier OR empty invoice). Those need per-slip triage.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-summary-recompute.ts [--apply] [--supplier=<name>] [--limit=N]
 *
 *   --apply     required to actually write. Without it, prints a dry-run plan.
 *   --supplier  restrict to one supplier slug (e.g. "carusos").
 *   --limit     cap the number of groups processed (dry-run always processes all).
 */
import { readDeliveryRows, recomputeSummaryForSlip } from "./sheets.js";
import type { DeliverySheetRow } from "./types.js";

function parseArgs(): { apply: boolean; supplier?: string; limit?: number } {
  const args = process.argv.slice(2);
  let apply = false;
  let supplier: string | undefined;
  let limit: number | undefined;
  for (const a of args) {
    if (a === "--apply") apply = true;
    else if (a.startsWith("--supplier=")) supplier = a.slice("--supplier=".length);
    else if (a.startsWith("--limit=")) limit = parseInt(a.slice("--limit=".length), 10);
  }
  return { apply, supplier, limit };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// recomputeSummaryForSlip does 2 sheet reads + 1 write per call. Google's
// per-user-per-minute quota is 60 reads and 60 writes. Pace at ~2s per slip
// so we stay under both without needing per-run backoff heroics.
const THROTTLE_MS = 2000;

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = (err as Error).message ?? "";
      const isQuota = msg.includes("Quota exceeded") || msg.includes("429");
      if (!isQuota) throw err;
      const backoffMs = 60_000 + i * 30_000;
      console.warn(`  quota hit, sleeping ${backoffMs / 1000}s before retry ${i + 1}/${attempts}...`);
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const { apply, supplier: supplierFilter, limit } = parseArgs();
  console.log(`# backfill-summary-recompute · mode=${apply ? "APPLY" : "DRY-RUN"}${supplierFilter ? ` · supplier=${supplierFilter}` : ""}`);

  const deliveryRows = await readDeliveryRows({ limit: 20000 });
  console.log(`Read ${deliveryRows.length} delivery rows.`);

  const groups = new Map<string, DeliverySheetRow[]>();
  let skippedNoKey = 0;
  for (const r of deliveryRows) {
    const supplier = (r.supplier ?? "").trim();
    const invoice = (r.invoice_or_order_number ?? "").trim();
    if (!supplier || !invoice) {
      skippedNoKey += 1;
      continue;
    }
    if (supplierFilter && supplier !== supplierFilter) continue;
    const key = `${supplier}::${invoice}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  console.log(`Grouped into ${groups.size} distinct (supplier, invoice) slips. Skipped ${skippedNoKey} rows with empty supplier or invoice.`);

  const entries = Array.from(groups.entries());
  const toProcess = limit ? entries.slice(0, limit) : entries;
  console.log(`Processing ${toProcess.length}${limit ? ` (capped at --limit=${limit})` : ""} slip(s)...`);
  console.log(``);

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < toProcess.length; i++) {
    const [key, rows] = toProcess[i];
    const first = rows[0];
    const prefix = `[${i + 1}/${toProcess.length}] ${key}`;
    if (!apply) {
      console.log(`${prefix} — ${rows.length} rows · delivery_date=${first.delivery_date ?? "-"} · photo_url=${first.photo_url ? "yes" : "NO"} (dry-run)`);
      ok += 1;
      continue;
    }
    try {
      await withRetry(() => recomputeSummaryForSlip(rows));
      console.log(`${prefix} — ${rows.length} rows · recomputed`);
      ok += 1;
    } catch (err) {
      console.error(`${prefix} — FAILED: ${(err as Error).message}`);
      failed += 1;
    }
    if (i < toProcess.length - 1) await sleep(THROTTLE_MS);
  }

  console.log(``);
  console.log(`Done. ok=${ok} failed=${failed}${apply ? "" : " (dry-run — no writes)"}`);
  if (!apply) console.log(`Re-run with --apply to write.`);
}

main().catch((err) => {
  console.error("backfill failed:", (err as Error).message);
  process.exit(1);
});
