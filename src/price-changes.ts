// Flags recent per-item price fluctuations from the Inbound Delivery Log.
//
// The core question RVFB wants to answer: "did any of the produce we buy
// jump or drop in price this week?" We split the priced (non-donation,
// non-fee) rows into a recent window and a prior window of equal length,
// group by (supplier, item, unit), and surface groups whose average
// unit_cost moved by more than a threshold.
//
// Kept pure and side-effect-free so dashboard.ts and chat.ts can share it.

import type { DeliverySheetRow } from "./types.js";

// Mirror of the DONATION_SUPPLIERS set in src/sheets.ts + src/dashboard.ts +
// src/chat.ts — see the note in chat.ts for why we duplicate rather than
// share. TODO: consolidate once one of these files needs a fifth copy.
const DONATION_SUPPLIERS = new Set<string>([
  "nw_harvest", "food_lifeline", "grocery_rescue", "hayton_farms", "grand_central"
]);

function parseBoolCell(v: string | null | undefined): boolean | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

function isDonationRow(r: DeliverySheetRow): boolean {
  const explicit = parseBoolCell(r.is_donation);
  if (explicit != null) return explicit;
  return DONATION_SUPPLIERS.has((r.supplier ?? "").trim().toLowerCase());
}

function isFeeRow(r: DeliverySheetRow): boolean {
  return parseBoolCell(r.is_fee) === true;
}

function toNumber(v: string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function todayPtIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + n * 86400000;
  const dt = new Date(t);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export interface PriceChangeItem {
  supplier: string;
  item: string;
  unit: string;
  prior_avg_cost: number;
  recent_avg_cost: number;
  pct_change: number;               // e.g. 0.42 = +42%, -0.18 = -18%
  prior_order_count: number;
  recent_order_count: number;
  prior_spend: number;
  recent_spend: number;
  direction: "up" | "down";
}

export interface PriceChangeParams {
  asOf?: string;                    // YYYY-MM-DD PT, default = today PT
  windowDays?: number;              // recent window length in days (equal prior window follows), default 14
  thresholdPct?: number;            // 0.20 = ±20%, default 0.20
  minObservationsPerWindow?: number; // default 2
  minRecentSpend?: number;          // default $50 to suppress noise on tiny buys
  supplier?: string;                // optional supplier slug filter
  itemContains?: string;            // optional case-insensitive item substring filter
}

export interface PriceChangeReport {
  asOf: string;
  windowDays: number;
  thresholdPct: number;
  minObservationsPerWindow: number;
  minRecentSpend: number;
  recentWindow: { start: string; end: string };
  priorWindow: { start: string; end: string };
  items: PriceChangeItem[];
}

export function computePriceChanges(
  inbound: DeliverySheetRow[],
  params: PriceChangeParams = {}
): PriceChangeReport {
  const asOf = params.asOf ?? todayPtIso();
  const windowDays = params.windowDays ?? 14;
  const thresholdPct = params.thresholdPct ?? 0.20;
  const minObs = params.minObservationsPerWindow ?? 2;
  const minRecentSpend = params.minRecentSpend ?? 50;
  const supplierFilter = params.supplier ? params.supplier.toLowerCase() : null;
  const itemContains = params.itemContains ? params.itemContains.toLowerCase() : null;

  const recentEnd = asOf;
  const recentStart = addDays(asOf, -(windowDays - 1));
  const priorEnd = addDays(recentStart, -1);
  const priorStart = addDays(priorEnd, -(windowDays - 1));

  interface Group {
    supplier: string;
    item: string;
    unit: string;
    recent: DeliverySheetRow[];
    prior: DeliverySheetRow[];
  }
  const groups = new Map<string, Group>();

  for (const r of inbound) {
    if (isFeeRow(r) || isDonationRow(r)) continue;
    const cost = toNumber(r.unit_cost);
    if (cost <= 0) continue;
    const d = r.delivery_date;
    if (!d || d < priorStart || d > recentEnd) continue;
    const supplier = (r.supplier ?? "").trim();
    if (!supplier) continue;
    if (supplierFilter && supplier.toLowerCase() !== supplierFilter) continue;
    const item = (r.item_name_normalized || r.item_name_raw || "").trim();
    if (!item) continue;
    if (itemContains && !item.toLowerCase().includes(itemContains)) continue;
    const unit = (r.unit ?? "").trim().toLowerCase();

    const key = `${supplier}::${item}::${unit}`;
    let g = groups.get(key);
    if (!g) {
      g = { supplier, item, unit, recent: [], prior: [] };
      groups.set(key, g);
    }
    if (d >= recentStart) g.recent.push(r);
    else g.prior.push(r);
  }

  const items: PriceChangeItem[] = [];
  for (const g of groups.values()) {
    if (g.recent.length < minObs || g.prior.length < minObs) continue;
    const recentCosts = g.recent.map((r) => toNumber(r.unit_cost));
    const priorCosts = g.prior.map((r) => toNumber(r.unit_cost));
    const recentAvg = recentCosts.reduce((s, n) => s + n, 0) / recentCosts.length;
    const priorAvg = priorCosts.reduce((s, n) => s + n, 0) / priorCosts.length;
    if (priorAvg <= 0) continue;
    const pctChange = (recentAvg - priorAvg) / priorAvg;
    if (Math.abs(pctChange) < thresholdPct) continue;
    const recentSpend = g.recent.reduce((s, r) => s + toNumber(r.line_total), 0);
    if (recentSpend < minRecentSpend) continue;
    const priorSpend = g.prior.reduce((s, r) => s + toNumber(r.line_total), 0);
    items.push({
      supplier: g.supplier,
      item: g.item,
      unit: g.unit,
      prior_avg_cost: Math.round(priorAvg * 100) / 100,
      recent_avg_cost: Math.round(recentAvg * 100) / 100,
      pct_change: Math.round(pctChange * 1000) / 1000,
      prior_order_count: g.prior.length,
      recent_order_count: g.recent.length,
      prior_spend: Math.round(priorSpend * 100) / 100,
      recent_spend: Math.round(recentSpend * 100) / 100,
      direction: pctChange >= 0 ? "up" : "down"
    });
  }

  items.sort((a, b) => Math.abs(b.pct_change) - Math.abs(a.pct_change));

  return {
    asOf,
    windowDays,
    thresholdPct,
    minObservationsPerWindow: minObs,
    minRecentSpend,
    recentWindow: { start: recentStart, end: recentEnd },
    priorWindow: { start: priorStart, end: priorEnd },
    items
  };
}
