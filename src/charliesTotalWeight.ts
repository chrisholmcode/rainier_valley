import type { ExtractionResult } from "./types.js";

// Post-extraction reconciliation for Charlie's Produce invoices.
//
// Charlie's prints a TOTAL WEIGHT footer that reconciles the per-line APPROX.WT
// column × SHIP quantity. The prompt says `approx_weight = APPROX.WT × quantity`,
// but on some slips the model stores the raw per-case APPROX.WT value instead
// (Karey flagged 102249964 and 102274219 on 2026-11-08; the trace on 102249964
// literally said "sum of line approx weights (183 lb) differs" from the printed
// 1640 lb footer and wrote per-case anyway). This catches that class of error
// deterministically using the invoice's own printed total as ground truth.
//
// Rules:
//   - No-op when supplier !== "charlies".
//   - No-op when totals.total_weight_lb is null (document didn't print one).
//   - If Σ approx_weight is already within 5% of the printed total → OK, no-op.
//   - Else if Σ (approx_weight × quantity) is within 5% of the printed total →
//     per-case bug detected; rewrite each line's approx_weight to × quantity,
//     preserving the prior value in notes, and push a source_warning.
//   - Else → flag a source_warning so the slip lands in /review but DO NOT
//     silently rewrite (the heuristic can't resolve the discrepancy).

const TOLERANCE = 0.05;

export type CharliesTotalWeightAction = "noop" | "already_matches" | "rewrote_per_case" | "flagged_mismatch";

export interface CharliesTotalWeightResult {
  action: CharliesTotalWeightAction;
  printedTotalLb: number | null;
  sumApproxLb: number | null;
  sumApproxTimesQtyLb: number | null;
  rewrites: number;
}

export function reconcileCharliesTotalWeight(extraction: ExtractionResult): CharliesTotalWeightResult {
  if (extraction.supplier !== "charlies") {
    return { action: "noop", printedTotalLb: null, sumApproxLb: null, sumApproxTimesQtyLb: null, rewrites: 0 };
  }
  const printed = extraction.totals.total_weight_lb;
  if (printed == null || !Number.isFinite(printed) || printed <= 0) {
    return { action: "noop", printedTotalLb: null, sumApproxLb: null, sumApproxTimesQtyLb: null, rewrites: 0 };
  }

  let sumApprox = 0;
  let sumApproxTimesQty = 0;
  for (const item of extraction.line_items) {
    if (item.is_fee) continue;
    const w = typeof item.approx_weight === "number" && Number.isFinite(item.approx_weight) ? item.approx_weight : 0;
    const q = typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
    sumApprox += w;
    sumApproxTimesQty += w * q;
  }

  const within = (a: number, b: number) => Math.abs(a - b) / b <= TOLERANCE;

  if (within(sumApprox, printed)) {
    return {
      action: "already_matches",
      printedTotalLb: printed,
      sumApproxLb: Number(sumApprox.toFixed(2)),
      sumApproxTimesQtyLb: Number(sumApproxTimesQty.toFixed(2)),
      rewrites: 0
    };
  }

  if (within(sumApproxTimesQty, printed)) {
    let rewrites = 0;
    for (const item of extraction.line_items) {
      if (item.is_fee) continue;
      const w = typeof item.approx_weight === "number" && Number.isFinite(item.approx_weight) ? item.approx_weight : null;
      const q = typeof item.quantity === "number" && Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : null;
      if (w == null || q == null || q <= 1) continue;
      const next = Number((w * q).toFixed(2));
      if (Math.abs(w - next) < 0.01) continue;
      const prevNote = item.notes ? `${item.notes} ` : "";
      item.notes = `${prevNote}[charlies total-weight reconcile: approx_weight ${w}→${next} (per-case×qty, reconciled against printed TOTAL WEIGHT ${printed} lb)]`;
      item.approx_weight = next;
      rewrites++;
    }
    extraction.source_warnings.push(
      `Charlie's total-weight reconcile: line approx_weight values looked per-case (sum ${sumApprox.toFixed(2)} lb) but per-case × qty (${sumApproxTimesQty.toFixed(2)} lb) matches printed TOTAL WEIGHT ${printed} lb within ${Math.round(TOLERANCE * 100)}%. Rewrote ${rewrites} line(s) to per-line.`
    );
    return {
      action: "rewrote_per_case",
      printedTotalLb: printed,
      sumApproxLb: Number(sumApprox.toFixed(2)),
      sumApproxTimesQtyLb: Number(sumApproxTimesQty.toFixed(2)),
      rewrites
    };
  }

  extraction.source_warnings.push(
    `Charlie's total-weight reconcile: sum of line approx_weight (${sumApprox.toFixed(2)} lb) differs from printed TOTAL WEIGHT (${printed} lb) and per-case × qty (${sumApproxTimesQty.toFixed(2)} lb) doesn't resolve it. Review required.`
  );
  return {
    action: "flagged_mismatch",
    printedTotalLb: printed,
    sumApproxLb: Number(sumApprox.toFixed(2)),
    sumApproxTimesQtyLb: Number(sumApproxTimesQty.toFixed(2)),
    rewrites: 0
  };
}
