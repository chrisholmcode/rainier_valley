import type { DeliverySheetRow, EodSheetRow, ProgramType } from "./types.js";
import { SHARED_CSS, FONT_HEAD_LINKS } from "./ui-styles.js";
import { env } from "./config.js";
import { CHAT_PANEL_CSS, CHAT_PANEL_JS, chatPanelHtml } from "./chat.js";

const PROGRAM_LABEL: Record<ProgramType, string> = {
  home_delivery: "Home Delivery",
  in_person_shopping: "In Person Shopping",
  pre_made_bags: "Pre Made Bags",
  unknown: "Unknown"
};

const PROGRAM_ORDER: ProgramType[] = ["home_delivery", "in_person_shopping", "pre_made_bags", "unknown"];

// Suppliers whose inbound is always treated as donated even when the row-level
// is_donation column is blank. Mirrors DONATION_SUPPLIERS in src/sheets.ts —
// keep in sync.
const DONATION_SUPPLIERS = new Set<string>([
  "nw_harvest",
  "food_lifeline",
  "grocery_rescue",
  "hayton_farms",
  "grand_central"
]);

export type View = "daily" | "weekly";

export interface Bucket {
  key: string;
  startDate: string;
  endDate: string;
  inboundPounds: number;
  poundsPurchased: number;
  poundsDonated: number;
  purchasePrice: number;
  outboundCases: number;
  outboundByProgram: Record<ProgramType, number>;
  inboundWeighedRows: number;
  inboundUnweighedRows: number;
  vendors: string[];
  topInbound: Array<{ name: string; qty: number }>;
  topOutbound: Array<{ name: string; qty: number }>;
  invoiceCount: number;
  sessionCount: number;
}

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
  const supplier = (r.supplier ?? "").trim().toLowerCase();
  return DONATION_SUPPLIERS.has(supplier);
}

function emptyProgramMap(): Record<ProgramType, number> {
  return { home_delivery: 0, in_person_shopping: 0, pre_made_bags: 0, unknown: 0 };
}

const TZ = "America/Los_Angeles";

function ymd(dt: Date): string {
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function todayInTz(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(s: string, n: number): string {
  return ymd(new Date(parseDate(s).getTime() + n * 86400000));
}

// Sunday that starts the week containing the given date (Sun-Sat weeks).
function weekStartOf(dateStr: string): string {
  const dt = parseDate(dateStr);
  const dow = dt.getUTCDay(); // 0=Sun..6=Sat
  return ymd(new Date(dt.getTime() - dow * 86400000));
}

function dailyRange(days: number): Array<{ key: string; startDate: string; endDate: string }> {
  const end = todayInTz();
  const out: Array<{ key: string; startDate: string; endDate: string }> = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(end, -i);
    out.push({ key: d, startDate: d, endDate: d });
  }
  return out;
}

function weeklyRange(weeks: number): Array<{ key: string; startDate: string; endDate: string }> {
  const currentSun = weekStartOf(todayInTz());
  const out: Array<{ key: string; startDate: string; endDate: string }> = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(currentSun, -i * 7);
    const end = addDays(start, 6);
    out.push({ key: start, startDate: start, endDate: end });
  }
  return out;
}

function bucketKeyFor(date: string | null | undefined, view: View): string | null {
  if (!date) return null;
  if (view === "daily") return date;
  return weekStartOf(date);
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

// Grocery rescue slips carry a fixed skeleton of 10 category rows regardless of
// what's on the form. Rows the extractor synthesized for categories the form
// left blank (Coffee Kiosk hatched out, Non-Meat Protein empty, etc.) look
// "unweighed" but there was never any inventory to weigh — they're placeholders
// for the reviewer's benefit. Exclude them from coverage math so grocery rescue
// isn't unfairly penalized. Reviewer-filled skeletons (quantity now populated)
// still count normally.
function isEmptySkeletonRow(r: DeliverySheetRow): boolean {
  if (!r.notes || !r.notes.includes("auto-inserted skeleton")) return false;
  const q = (r.quantity ?? "").trim();
  return q === "" || q === "0" || toNumber(r.quantity) === 0;
}

// Pounds for an inbound row. Prefer approx_weight (line-total pounds populated
// by the extractor). Fall back to quantity when the unit is already "lb"
// (grocery rescue + Weigelt convention). Returns null when we can't infer a
// weight — the caller decides whether to count the row as "unweighed".
function inboundPoundsFor(r: DeliverySheetRow): number | null {
  const aw = toNumber(r.approx_weight);
  if (aw > 0) return aw;
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    const q = toNumber(r.quantity);
    if (q > 0) return q;
  }
  return null;
}

function topN(map: Map<string, number>, n: number): Array<{ name: string; qty: number }> {
  return Array.from(map.entries())
    .filter(([name]) => name && name.trim() !== "")
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([name, qty]) => ({ name, qty }));
}

export function aggregate(
  inboundRows: DeliverySheetRow[],
  outboundRows: EodSheetRow[],
  view: View,
  bucketList: Array<{ key: string; startDate: string; endDate: string }>
): Bucket[] {
  const range = bucketList;
  const buckets = new Map<string, Bucket>();
  for (const r of range) {
    buckets.set(r.key, {
      key: r.key,
      startDate: r.startDate,
      endDate: r.endDate,
      inboundPounds: 0,
      poundsPurchased: 0,
      poundsDonated: 0,
      purchasePrice: 0,
      outboundCases: 0,
      outboundByProgram: emptyProgramMap(),
      inboundWeighedRows: 0,
      inboundUnweighedRows: 0,
      vendors: [],
      topInbound: [],
      topOutbound: [],
      invoiceCount: 0,
      sessionCount: 0
    });
  }

  const inboundItems = new Map<string, Map<string, number>>();
  const vendorSets = new Map<string, Set<string>>();
  const invoiceSets = new Map<string, Set<string>>();
  const outboundItems = new Map<string, Map<string, number>>();
  const sessionSets = new Map<string, Set<string>>();

  for (const r of inboundRows) {
    const key = bucketKeyFor(r.delivery_date, view);
    if (!key || !buckets.has(key)) continue;
    if (isFee(r.is_fee)) continue;
    if (isEmptySkeletonRow(r)) continue;
    const bucket = buckets.get(key)!;

    const lbs = inboundPoundsFor(r);
    const donated = isDonationRow(r);
    if (lbs != null) {
      bucket.inboundPounds += lbs;
      bucket.inboundWeighedRows += 1;
      if (donated) bucket.poundsDonated += lbs;
      else bucket.poundsPurchased += lbs;
    } else {
      bucket.inboundUnweighedRows += 1;
    }
    if (!donated) {
      const lt = toNumber(r.line_total);
      if (lt > 0) bucket.purchasePrice += lt;
    }

    if (r.supplier && r.supplier.trim()) {
      let vs = vendorSets.get(key);
      if (!vs) vendorSets.set(key, (vs = new Set()));
      vs.add(r.supplier.trim());
    }

    if (r.supplier && r.invoice_or_order_number) {
      let is = invoiceSets.get(key);
      if (!is) invoiceSets.set(key, (is = new Set()));
      is.add(`${r.supplier}::${r.invoice_or_order_number}`);
    }

    const name = (r.item_name_normalized || r.item_name_raw || "").trim();
    if (name && lbs != null && lbs > 0) {
      let im = inboundItems.get(key);
      if (!im) inboundItems.set(key, (im = new Map()));
      im.set(name, (im.get(name) ?? 0) + lbs);
    }
  }

  for (const r of outboundRows) {
    const key = bucketKeyFor(r.date, view);
    if (!key || !buckets.has(key)) continue;
    const qty = toNumber(r.quantity);
    const bucket = buckets.get(key)!;
    bucket.outboundCases += qty;
    const pt = (r.program_type || "unknown") as ProgramType;
    const programKey: ProgramType = pt in bucket.outboundByProgram ? pt : "unknown";
    bucket.outboundByProgram[programKey] += qty;

    const sessionKey = r.slack_message_ts || `manual::${r.recorded_at || r.rowIndex}`;
    let ss = sessionSets.get(key);
    if (!ss) sessionSets.set(key, (ss = new Set()));
    ss.add(sessionKey);

    const name = (r.item_name_normalized || r.item_name_raw || "").trim();
    if (name && qty > 0) {
      let im = outboundItems.get(key);
      if (!im) outboundItems.set(key, (im = new Map()));
      im.set(name, (im.get(name) ?? 0) + qty);
    }
  }

  for (const r of range) {
    const b = buckets.get(r.key)!;
    b.vendors = Array.from(vendorSets.get(r.key) ?? []).sort();
    b.invoiceCount = invoiceSets.get(r.key)?.size ?? 0;
    b.sessionCount = sessionSets.get(r.key)?.size ?? 0;
    b.topInbound = topN(inboundItems.get(r.key) ?? new Map(), 3);
    b.topOutbound = topN(outboundItems.get(r.key) ?? new Map(), 3);
  }

  return range.map((r) => buckets.get(r.key)!);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dailyColHeader(bucket: Bucket): string {
  const dt = parseDate(bucket.startDate);
  const weekday = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const monthDay = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `<div class="col-weekday">${escapeHtml(weekday)}</div><div class="col-date">${escapeHtml(monthDay)}</div>`;
}

function weeklyColHeader(bucket: Bucket): string {
  const start = parseDate(bucket.startDate);
  const end = parseDate(bucket.endDate);
  const startMonth = start.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const endMonth = end.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const startDay = start.getUTCDate();
  const endDay = end.getUTCDate();
  const label = startMonth === endMonth
    ? `${startMonth} ${startDay}–${endDay}`
    : `${startMonth} ${startDay} – ${endMonth} ${endDay}`;
  return `<div class="col-weekday">Week of</div><div class="col-date">${escapeHtml(label)}</div>`;
}

function chartLabel(bucket: Bucket, view: View): string {
  const start = parseDate(bucket.startDate);
  if (view === "daily") {
    return start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
  return start.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function vendorsCell(vendors: string[]): string {
  if (vendors.length === 0) return `<span class="muted">—</span>`;
  const shown = vendors.slice(0, 3).map((v) => escapeHtml(v)).join(", ");
  const extra = vendors.length > 3 ? ` <span class="muted">+${vendors.length - 3}</span>` : "";
  return shown + extra;
}

function itemsCell(items: Array<{ name: string; qty: number }>): string {
  if (items.length === 0) return `<span class="muted">—</span>`;
  return items
    .map((i) => `${escapeHtml(i.name)} <span class="muted">(${formatNum(i.qty)})</span>`)
    .join("<br>");
}

function formatNum(n: number): string {
  if (n === 0) return "0";
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

function metricCell(n: number, kind: "in" | "out"): string {
  if (n === 0) return `<span class="muted">0</span>`;
  return `<span class="num-${kind}">${formatNum(n)}</span>`;
}

function formatMoney(n: number): string {
  const rounded = Math.round(n);
  return "$" + rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function moneyCell(n: number): string {
  if (n <= 0) return `<span class="muted">$0</span>`;
  return `<span class="num-in">${formatMoney(n)}</span>`;
}

function coverageCell(bucket: Bucket): string {
  const total = bucket.inboundWeighedRows + bucket.inboundUnweighedRows;
  if (total === 0) return `<span class="muted">—</span>`;
  if (bucket.inboundUnweighedRows === 0) return `<span class="muted">${total}/${total}</span>`;
  return `<span class="num-out">${bucket.inboundWeighedRows}/${total}</span>`;
}

export interface InboundSlipDetail {
  photo_url: string | null;
  supplier: string;
  invoice_or_order_number: string | null;
  delivery_date: string | null;
  is_donation: boolean;
  line_count: number;
  total_pounds: number;
  unweighed_lines: number;
  purchase_price: number;
  min_confidence: number | null;
}

export interface OutboundSessionDetail {
  session_key: string;
  slack_channel: string | null;
  slack_message_ts: string | null;
  source: string;
  date: string | null;
  program_type: ProgramType | null;
  line_count: number;
  total_cases: number;
  photo_url: string | null;
  min_confidence: number | null;
}

export function collectInboundSlipDetails(
  inboundRows: DeliverySheetRow[],
  from: string,
  to: string
): InboundSlipDetail[] {
  const byKey = new Map<string, InboundSlipDetail>();
  for (const r of inboundRows) {
    const d = r.delivery_date;
    if (!d || d < from || d > to) continue;
    if (isFee(r.is_fee)) continue;
    if (isEmptySkeletonRow(r)) continue;
    // Group by photo_url when present, else by supplier+invoice — that's the
    // best fallback for email-intake / grocery-rescue rows that don't have a
    // Slack photo.
    const key = (r.photo_url && r.photo_url.trim())
      || `${r.supplier ?? ""}::${r.invoice_or_order_number ?? ""}::${d}`;
    let d0 = byKey.get(key);
    if (!d0) {
      d0 = {
        photo_url: r.photo_url && r.photo_url.trim() ? r.photo_url : null,
        supplier: r.supplier ?? "",
        invoice_or_order_number: r.invoice_or_order_number ?? null,
        delivery_date: d,
        is_donation: isDonationRow(r),
        line_count: 0,
        total_pounds: 0,
        unweighed_lines: 0,
        purchase_price: 0,
        min_confidence: null
      };
      byKey.set(key, d0);
    }
    d0.line_count += 1;
    const lbs = inboundPoundsFor(r);
    if (lbs != null) d0.total_pounds += lbs;
    else d0.unweighed_lines += 1;
    if (!d0.is_donation) {
      const lt = toNumber(r.line_total);
      if (lt > 0) d0.purchase_price += lt;
    }
    const c = r.confidence ? parseFloat(r.confidence) : NaN;
    if (Number.isFinite(c) && (d0.min_confidence === null || c < d0.min_confidence)) {
      d0.min_confidence = c;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const ad = a.delivery_date ?? "";
    const bd = b.delivery_date ?? "";
    if (ad !== bd) return bd.localeCompare(ad);
    return a.supplier.localeCompare(b.supplier);
  });
}

export function collectOutboundSessionDetails(
  outboundRows: EodSheetRow[],
  from: string,
  to: string
): OutboundSessionDetail[] {
  const byKey = new Map<string, OutboundSessionDetail>();
  for (const r of outboundRows) {
    const d = r.date;
    if (!d || d < from || d > to) continue;
    const key = (r.slack_channel && r.slack_message_ts)
      ? `${r.slack_channel}:${r.slack_message_ts}`
      : `manual::${r.recorded_at || r.rowIndex}`;
    let s = byKey.get(key);
    if (!s) {
      s = {
        session_key: key,
        slack_channel: r.slack_channel,
        slack_message_ts: r.slack_message_ts,
        source: r.source ?? "unknown",
        date: d,
        program_type: r.program_type ?? null,
        line_count: 0,
        total_cases: 0,
        photo_url: r.photo_url && r.photo_url.trim() ? r.photo_url : null,
        min_confidence: null
      };
      byKey.set(key, s);
    }
    s.line_count += 1;
    s.total_cases += toNumber(r.quantity);
    if (!s.photo_url && r.photo_url && r.photo_url.trim()) s.photo_url = r.photo_url;
    const c = r.confidence ? parseFloat(r.confidence) : NaN;
    if (Number.isFinite(c) && (s.min_confidence === null || c < s.min_confidence)) {
      s.min_confidence = c;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const ad = a.date ?? "";
    const bd = b.date ?? "";
    if (ad !== bd) return bd.localeCompare(ad);
    return a.source.localeCompare(b.source);
  });
}

export type Range = "1w" | "4w";

// A dashboard window is one of: a recent rolling range (last 7d / 28d), a
// specific calendar month, or an explicit custom [from, to] span. The URL
// param combo determines which is active: `month=YYYY-MM` wins over
// `from`/`to`, both win over `range`. Kept as a discriminated union so the
// bucket generator + label helpers stay type-safe.
export type WindowSpec =
  | { kind: "recent"; range: Range }
  | { kind: "month"; month: string; from: string; to: string }
  | { kind: "custom"; from: string; to: string };

interface ViewOption {
  view: View;
  spec: WindowSpec;
}

function periodsFor(view: View, range: Range): number {
  if (view === "daily") return range === "1w" ? 7 : 28;
  return range === "1w" ? 1 : 4;
}

function daysInMonthOf(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthToRange(month: string): { from: string; to: string } {
  const days = daysInMonthOf(month);
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}` };
}

function dailyRangeBetween(from: string, to: string): Array<{ key: string; startDate: string; endDate: string }> {
  const start = parseDate(from);
  const end = parseDate(to);
  const out: Array<{ key: string; startDate: string; endDate: string }> = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = ymd(new Date(t));
    out.push({ key: d, startDate: d, endDate: d });
  }
  return out;
}

// Weekly buckets whose Sunday start is inside [from, to]. Selecting August
// gives you the Sundays that land in August (Aug 2, 9, 16, 23, 30 for 2026),
// each labeled as its full Sun–Sat span even if the tail leaks into September.
function weeklyRangeBetween(from: string, to: string): Array<{ key: string; startDate: string; endDate: string }> {
  const start = parseDate(from);
  const end = parseDate(to);
  const firstSunday = new Date(start.getTime() + ((7 - start.getUTCDay()) % 7) * 86400000);
  const out: Array<{ key: string; startDate: string; endDate: string }> = [];
  for (let t = firstSunday.getTime(); t <= end.getTime(); t += 7 * 86400000) {
    const startStr = ymd(new Date(t));
    const endStr = ymd(new Date(t + 6 * 86400000));
    out.push({ key: startStr, startDate: startStr, endDate: endStr });
  }
  return out;
}

export function resolveBuckets(view: View, spec: WindowSpec): Array<{ key: string; startDate: string; endDate: string }> {
  if (spec.kind === "recent") {
    const periods = periodsFor(view, spec.range);
    return view === "daily" ? dailyRange(periods) : weeklyRange(periods);
  }
  return view === "daily"
    ? dailyRangeBetween(spec.from, spec.to)
    : weeklyRangeBetween(spec.from, spec.to);
}

function specWindow(spec: WindowSpec): { from: string; to: string } {
  if (spec.kind === "recent") {
    const days = spec.range === "1w" ? 7 : 28;
    const to = todayInTz();
    const from = addDays(to, -(days - 1));
    return { from, to };
  }
  return { from: spec.from, to: spec.to };
}

function specToQuery(spec: WindowSpec): string {
  if (spec.kind === "recent") return `range=${spec.range}`;
  if (spec.kind === "month") return `month=${spec.month}`;
  return `from=${spec.from}&amp;to=${spec.to}`;
}

function windowLabel(spec: WindowSpec): string {
  if (spec.kind === "recent") {
    return spec.range === "1w" ? "Last 7 days" : "Last 28 days";
  }
  if (spec.kind === "month") {
    const [y, m] = spec.month.split("-").map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  return `${spec.from} to ${spec.to}`;
}

function csvField(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsvExport(params: {
  spec: WindowSpec;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  program: ProgramType | null;
}): { filename: string; csv: string } {
  const { spec, inboundRows, outboundRows, program } = params;
  const win = specWindow(spec);
  const dates = dailyRangeBetween(win.from, win.to).map((r) => r.startDate);
  const dateSet = new Set(dates);
  const startDate = dates[0];
  const endDate = dates[dates.length - 1];

  const rows: Array<{
    date: string;
    direction: "inbound" | "outbound";
    item: string;
    quantity: number;
    unit: string;
    pounds: number | null;
    line_total: number | null;
    is_donation: string;
    supplier: string;
    reference: string;
    category: string;
    program_type: string;
  }> = [];

  for (const r of inboundRows) {
    const d = r.delivery_date;
    if (!d || !dateSet.has(d)) continue;
    if (isFee(r.is_fee)) continue;
    const lt = toNumber(r.line_total);
    rows.push({
      date: d,
      direction: "inbound",
      item: (r.item_name_normalized || r.item_name_raw || "").trim(),
      quantity: toNumber(r.quantity),
      unit: (r.unit ?? "").trim(),
      pounds: inboundPoundsFor(r),
      line_total: lt > 0 || r.line_total ? lt : null,
      is_donation: isDonationRow(r) ? "TRUE" : "FALSE",
      supplier: (r.supplier ?? "").trim(),
      reference: (r.invoice_or_order_number ?? "").trim(),
      category: (r.category ?? "").trim(),
      program_type: ""
    });
  }

  for (const r of outboundRows) {
    const d = r.date;
    if (!d || !dateSet.has(d)) continue;
    rows.push({
      date: d,
      direction: "outbound",
      item: (r.item_name_normalized || r.item_name_raw || "").trim(),
      quantity: toNumber(r.quantity),
      unit: (r.unit ?? "").trim(),
      pounds: null,
      line_total: null,
      is_donation: "",
      supplier: "",
      reference: r.slack_message_ts ?? "",
      category: (r.category ?? "").trim(),
      program_type: r.program_type ?? ""
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.direction !== b.direction) return a.direction === "inbound" ? -1 : 1;
    return a.item.localeCompare(b.item);
  });

  const header = ["date", "direction", "item", "quantity", "unit", "pounds", "line_total", "is_donation", "supplier", "reference", "category", "program_type"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvField(r.date),
      csvField(r.direction),
      csvField(r.item),
      csvField(formatNum(r.quantity)),
      csvField(r.unit),
      csvField(r.pounds == null ? "" : formatNum(r.pounds)),
      csvField(r.line_total == null ? "" : r.line_total.toFixed(2)),
      csvField(r.is_donation),
      csvField(r.supplier),
      csvField(r.reference),
      csvField(r.category),
      csvField(r.program_type)
    ].join(","));
  }

  const programSlug = program ? `-${program}` : "";
  return {
    filename: `${env.TENANT_SHORT.toLowerCase()}-export${programSlug}-${startDate}_to_${endDate}.csv`,
    csv: lines.join("\n") + "\n"
  };
}

function programSuffix(program: ProgramType | null): string {
  return program ? `&amp;program=${program}` : "";
}

// Token-mode auth (local dev) requires ?token= on every request. In CF Access
// prod the token param is "" so this is a no-op.
function tokenSuffix(token: string): string {
  return token ? `&amp;token=${encodeURIComponent(token)}` : "";
}

function viewButtons(active: ViewOption, token: string, program: ProgramType | null): string {
  const progParam = programSuffix(program);
  const specParam = specToQuery(active.spec);
  const tokParam = tokenSuffix(token);
  const dailyCls = active.view === "daily" ? "btn active" : "btn";
  const weeklyCls = active.view === "weekly" ? "btn active" : "btn";
  return `
    <a class="${dailyCls}" href="?view=daily&amp;${specParam}${progParam}${tokParam}">Daily</a>
    <a class="${weeklyCls}" href="?view=weekly&amp;${specParam}${progParam}${tokParam}">Weekly</a>
  `;
}

function programButtons(active: ViewOption, token: string, activeProgram: ProgramType | null): string {
  const specParam = specToQuery(active.spec);
  const tokParam = tokenSuffix(token);
  const opts: Array<{ label: string; value: ProgramType | null }> = [
    { label: "All", value: null },
    { label: "Home Delivery", value: "home_delivery" },
    { label: "In Person Shopping", value: "in_person_shopping" },
    { label: "Pre Made Bags", value: "pre_made_bags" }
  ];
  return opts
    .map((o) => {
      const isActive = (o.value ?? null) === (activeProgram ?? null);
      const cls = isActive ? "btn active" : "btn";
      const progParam = o.value ? `&amp;program=${o.value}` : "";
      return `<a class="${cls}" href="?view=${active.view}&amp;${specParam}${progParam}${tokParam}">${o.label}</a>`;
    })
    .join("");
}

// Period picker consolidates the old "1w / 4w" range buttons with a month
// dropdown so users can pull up historical months without needing a separate
// control. Emits URLs via specToQuery so back/forward + bookmarks work.
function periodPicker(active: ViewOption, program: ProgramType | null, token: string): string {
  const progParam = programSuffix(program);
  const tokParam = tokenSuffix(token);
  const months = rescueMonthOptions();
  const spec = active.spec;

  const options: Array<{ value: string; label: string; selected: boolean }> = [];
  options.push({ value: "range:1w", label: "Last 7 days", selected: spec.kind === "recent" && spec.range === "1w" });
  options.push({ value: "range:4w", label: "Last 28 days", selected: spec.kind === "recent" && spec.range === "4w" });
  for (const m of months) {
    options.push({
      value: `month:${m.value}`,
      label: m.label,
      selected: spec.kind === "month" && spec.month === m.value
    });
  }
  options.push({ value: "custom", label: "Custom range…", selected: spec.kind === "custom" });

  const optionHtml = options
    .map((o) => `<option value="${o.value}"${o.selected ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");

  const customFrom = spec.kind === "custom" ? spec.from : "";
  const customTo = spec.kind === "custom" ? spec.to : "";
  const customHidden = spec.kind === "custom" ? "" : " hidden";

  return `
<span class="period-picker">
  <select id="period-select" class="period-select">${optionHtml}</select>
  <span id="period-custom" class="period-custom"${customHidden}>
    <input type="date" id="period-from" class="period-date" value="${escapeHtml(customFrom)}">
    <span class="period-dash">→</span>
    <input type="date" id="period-to" class="period-date" value="${escapeHtml(customTo)}">
    <button type="button" id="period-apply" class="btn btn-secondary">Apply</button>
  </span>
</span>
<script>
(function(){
  var sel = document.getElementById('period-select');
  var custom = document.getElementById('period-custom');
  var fromEl = document.getElementById('period-from');
  var toEl = document.getElementById('period-to');
  var apply = document.getElementById('period-apply');
  var view = ${JSON.stringify(active.view)};
  var progParam = ${JSON.stringify(progParam.replace(/&amp;/g, "&"))};
  var tokParam = ${JSON.stringify(tokParam.replace(/&amp;/g, "&"))};
  function jumpTo(query) {
    var url = '?view=' + view + '&' + query + progParam + tokParam;
    window.location.href = url;
  }
  sel.addEventListener('change', function(){
    var val = sel.value;
    if (val === 'custom') {
      custom.hidden = false;
      return;
    }
    custom.hidden = true;
    if (val.indexOf('range:') === 0) jumpTo('range=' + encodeURIComponent(val.slice(6)));
    else if (val.indexOf('month:') === 0) jumpTo('month=' + encodeURIComponent(val.slice(6)));
  });
  apply.addEventListener('click', function(){
    var f = fromEl.value, t = toEl.value;
    if (!f || !t) return;
    if (f > t) { var tmp = f; f = t; t = tmp; }
    jumpTo('from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t));
  });
})();
</script>`;
}

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function rescueMonthOptions(): Array<{ value: string; label: string; from: string; to: string }> {
  const [ty, tm] = todayInTz().split("-").map(Number);
  const anchor = ty * 12 + (tm - 1);
  const opts: Array<{ value: string; label: string; from: string; to: string }> = [];
  for (let i = 0; i < 12; i++) {
    const total = anchor - i;
    const yy = Math.floor(total / 12);
    const m0 = total - yy * 12;
    const monthNum = m0 + 1;
    const daysInMonth = new Date(Date.UTC(yy, monthNum, 0)).getUTCDate();
    const value = `${yy}-${String(monthNum).padStart(2, "0")}`;
    const from = `${value}-01`;
    const to = `${value}-${String(daysInMonth).padStart(2, "0")}`;
    const label = i === 0
      ? `This month (${MONTH_NAMES[m0]} ${yy})`
      : `${MONTH_NAMES[m0]} ${yy}`;
    opts.push({ value, label, from, to });
  }
  return opts;
}

// Rescue-export button — inherits the dashboard's currently-selected Period
// so users don't have to pick the month twice. The href regenerates on every
// render via specWindow.
function rescueExportControl(spec: WindowSpec, token: string): string {
  const win = specWindow(spec);
  return `<a class="btn btn-export" href="/export/grocery-rescue?from=${escapeHtml(win.from)}&amp;to=${escapeHtml(win.to)}${tokenSuffix(token)}" download>↓ Grocery rescue slips (Food Lifeline)</a>`;
}

export function buildDashboardHtml(params: {
  view: View;
  spec: WindowSpec;
  program: ProgramType | null;
  token: string;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  generatedAt: Date;
}): string {
  const { view, spec, program, token, inboundRows, outboundRows, generatedAt } = params;
  const bucketList = resolveBuckets(view, spec);
  const buckets = aggregate(inboundRows, outboundRows, view, bucketList);
  const generatedLabel = generatedAt.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  // Every metric cell carries the direction + date range that drives the
  // side-panel drilldown. Row-level direction is fixed by the row's meaning.
  function td(b: Bucket, dir: "inbound" | "outbound", inner: string, klass = "num"): string {
    return `<td class="${klass} bucket-cell" data-direction="${dir}" data-from="${b.startDate}" data-to="${b.endDate}">${inner}</td>`;
  }

  const colHeaderFn = view === "daily" ? dailyColHeader : weeklyColHeader;
  const headerCells = buckets.map((b) => `<th>${colHeaderFn(b)}</th>`).join("");
  const inboundPoundsRow = buckets.map((b) => td(b, "inbound", metricCell(b.inboundPounds, "in"))).join("");
  const poundsPurchasedRow = buckets.map((b) => td(b, "inbound", metricCell(b.poundsPurchased, "in"))).join("");
  const poundsDonatedRow = buckets.map((b) => td(b, "inbound", metricCell(b.poundsDonated, "in"))).join("");
  const purchasePriceRow = buckets.map((b) => td(b, "inbound", moneyCell(b.purchasePrice))).join("");
  const outboundCasesRow = buckets.map((b) => td(b, "outbound", metricCell(b.outboundCases, "out"))).join("");
  const programRows = program
    ? ""
    : PROGRAM_ORDER
        .filter((p) => buckets.some((b) => b.outboundByProgram[p] > 0))
        .map((p) => {
          const cells = buckets.map((b) => td(b, "outbound", metricCell(b.outboundByProgram[p], "out"))).join("");
          return `      <tr><th class="sub">↳ ${escapeHtml(PROGRAM_LABEL[p])}</th>${cells}</tr>`;
        })
        .join("\n");
  const coverageRow = buckets.map((b) => td(b, "inbound", coverageCell(b))).join("");
  const vendorsRow = buckets.map((b) => td(b, "inbound", vendorsCell(b.vendors), "")).join("");
  const topInRow = buckets.map((b) => td(b, "inbound", itemsCell(b.topInbound), "")).join("");
  const topOutRow = buckets.map((b) => td(b, "outbound", itemsCell(b.topOutbound), "")).join("");
  const invoicesRow = buckets.map((b) => td(b, "inbound", b.invoiceCount ? String(b.invoiceCount) : `<span class="muted">0</span>`)).join("");
  const sessionsRow = buckets.map((b) => td(b, "outbound", b.sessionCount ? String(b.sessionCount) : `<span class="muted">0</span>`)).join("");

  const chartLabels = JSON.stringify(buckets.map((b) => chartLabel(b, view)));
  const inboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.inboundPounds * 10) / 10));
  const outboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.outboundCases * 10) / 10));
  const bucketMeta = JSON.stringify(buckets.map((b) => ({ from: b.startDate, to: b.endDate })));
  const programParamJs = JSON.stringify(program ?? "");
  const tokenParamJs = JSON.stringify(token ?? "");

  const totalInboundPounds = buckets.reduce((s, b) => s + b.inboundPounds, 0);
  const totalPoundsPurchased = buckets.reduce((s, b) => s + b.poundsPurchased, 0);
  const totalPoundsDonated = buckets.reduce((s, b) => s + b.poundsDonated, 0);
  const totalPurchasePrice = buckets.reduce((s, b) => s + b.purchasePrice, 0);
  const totalOutbound = buckets.reduce((s, b) => s + b.outboundCases, 0);
  const totalByProgram: Record<ProgramType, number> = emptyProgramMap();
  for (const b of buckets) {
    for (const p of PROGRAM_ORDER) totalByProgram[p] += b.outboundByProgram[p];
  }

  const bucketKeys = new Set(buckets.map((b) => b.key));
  const programBreakdown = new Map<ProgramType, number>();
  for (const r of outboundRows) {
    const key = bucketKeyFor(r.date, view);
    if (!key || !bucketKeys.has(key)) continue;
    const pt = (r.program_type || "unknown") as ProgramType;
    const label: ProgramType = pt in PROGRAM_LABEL ? pt : "unknown";
    programBreakdown.set(label, (programBreakdown.get(label) ?? 0) + toNumber(r.quantity));
  }
  const programBreakdownEntries = Array.from(programBreakdown.entries())
    .filter(([, qty]) => qty > 0)
    .sort((a, b) => b[1] - a[1]);
  const totalWeighed = buckets.reduce((s, b) => s + b.inboundWeighedRows, 0);
  const totalUnweighed = buckets.reduce((s, b) => s + b.inboundUnweighedRows, 0);
  const totalInboundRows = totalWeighed + totalUnweighed;

  const active: ViewOption = { view, spec };
  const windowLbl = windowLabel(spec);
  const bucketWord = view === "daily" ? "day" : "week";
  const inboundPoundsLabel = view === "daily" ? "Inbound — pounds" : "Inbound — pounds (week)";
  const outboundCasesLabel = view === "daily" ? "Outbound — cases" : "Outbound — cases (week)";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${env.TENANT_SHORT} Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
${SHARED_CSS}
/* Dashboard-specific */
.card { overflow-x: auto; }
thead th { text-align: center; }
thead th:first-child { text-align: left; }
.col-weekday { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.col-date    { font-size: 13px; font-weight: 600; color: var(--ink); }
.chart-wrap  { position: relative; height: 320px; }

.period-picker { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.period-select, .period-date {
  font-family: inherit; font-size: 13px; font-weight: 500;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--line); border-radius: var(--radius-md);
  padding: 7px 10px; line-height: 1;
}
.period-select { padding-right: 24px; }
.period-custom { display: inline-flex; gap: 6px; align-items: center; }
.period-custom[hidden] { display: none; }
.period-dash { color: var(--muted); font-size: 12px; }
tbody th.sub { font-weight: 500; color: var(--muted); padding-left: 20px; }
.bucket-cell { cursor: pointer; transition: background 0.1s; }
.bucket-cell:hover { background: var(--hover, #f4f6fa); }
.chart-wrap canvas { cursor: pointer; }

/* Bucket detail slide-in panel */
.bucket-panel {
  position: fixed; top: 0; right: 0; bottom: 0;
  width: min(480px, 92vw);
  background: var(--card, #fff);
  border-left: 1px solid var(--line);
  box-shadow: -8px 0 24px rgba(10, 37, 64, 0.08);
  transform: translateX(100%);
  transition: transform 0.22s ease-out;
  display: flex; flex-direction: column;
  z-index: 1000;
}
.bucket-panel.open { transform: translateX(0); }
.bucket-panel-backdrop {
  position: fixed; inset: 0; background: rgba(10, 37, 64, 0.16);
  opacity: 0; pointer-events: none; transition: opacity 0.2s;
  z-index: 999;
}
.bucket-panel-backdrop.open { opacity: 1; pointer-events: auto; }
.bucket-panel-header {
  padding: 18px 20px 14px; border-bottom: 1px solid var(--line);
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
}
.bucket-panel-header h3 { margin: 0; font-size: 15px; font-weight: 700; }
.bucket-panel-header .sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
.bucket-panel-close {
  background: none; border: 0; font-size: 22px; line-height: 1;
  color: var(--muted); cursor: pointer; padding: 0 4px;
}
.bucket-panel-close:hover { color: var(--ink); }
.bucket-panel-body { flex: 1; overflow-y: auto; padding: 12px 20px 20px; }
.bucket-panel-empty { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
.bucket-panel-loading { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
.bucket-item {
  display: flex; gap: 12px; padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.bucket-item:last-child { border-bottom: 0; }
.bucket-item-thumb {
  width: 56px; height: 56px; flex-shrink: 0;
  border-radius: 6px; overflow: hidden;
  background: #f4f6fa; border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 10px; text-align: center;
}
.bucket-item-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.bucket-item-body { flex: 1; min-width: 0; }
.bucket-item-title {
  font-size: 13px; font-weight: 600; color: var(--ink);
  display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
}
.bucket-item-title a { color: var(--ink); text-decoration: none; }
.bucket-item-title a:hover { text-decoration: underline; }
.bucket-item-meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
.bucket-item-meta .sep { padding: 0 6px; opacity: 0.5; }
.bucket-item-tags { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
.bucket-tag {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 2px 6px; border-radius: 4px;
  background: #eef2f7; color: var(--ink-2, #425466);
}
.bucket-tag.donation { background: #e7f6ee; color: #067647; }
.bucket-tag.warn { background: #fdf1e2; color: #b45309; }
${CHAT_PANEL_CSS}
</style>
</head>
<body>
<div class="container">
<div class="layout">
<main class="dashboard-main">

<header class="page">
  <div>
    <h1>${env.TENANT_SHORT} Dashboard</h1>
    <div class="meta">${escapeHtml(windowLbl)} · Generated ${escapeHtml(generatedLabel)} PT</div>
  </div>
  <div class="toolbar">
    <div class="btn-group">${viewButtons(active, token, program)}</div>
    ${periodPicker(active, program, token)}
    <div class="btn-group">${programButtons(active, token, program)}</div>
    <a class="btn btn-export" href="?view=${view}&amp;${specToQuery(spec)}&amp;format=csv${programSuffix(program)}${tokenSuffix(token)}" download>↓ Export CSV</a>
    ${rescueExportControl(spec, token)}
    <button class="btn" id="chat-toggle-btn" type="button">Chat</button>
    <a class="btn" href="/coverage${token ? `?token=${encodeURIComponent(token)}` : ""}">Slip coverage →</a>
    <a class="btn" href="/review${token ? `?token=${encodeURIComponent(token)}` : ""}">Review queue →</a>
  </div>
</header>

<div class="summary-row">
  <div class="summary-pill in">
    <div class="label">Inbound · total pounds</div>
    <div class="value">${formatNum(totalInboundPounds)}</div>
    ${totalUnweighed > 0
      ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">from ${totalWeighed} of ${totalInboundRows} rows (${totalUnweighed} missing weight)</div>`
      : totalInboundRows > 0
        ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">from ${totalInboundRows} rows</div>`
        : ""}
  </div>
  <div class="summary-pill in">
    <div class="label">Pounds purchased</div>
    <div class="value">${formatNum(totalPoundsPurchased)}</div>
    ${totalInboundPounds > 0
      ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">${Math.round((totalPoundsPurchased / totalInboundPounds) * 100)}% of inbound</div>`
      : ""}
  </div>
  <div class="summary-pill in">
    <div class="label">Purchase price</div>
    <div class="value">${formatMoney(totalPurchasePrice)}</div>
    ${totalPoundsPurchased > 0
      ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">$${(totalPurchasePrice / totalPoundsPurchased).toFixed(2)} / lb</div>`
      : ""}
  </div>
  <div class="summary-pill in">
    <div class="label">Pounds donated</div>
    <div class="value">${formatNum(totalPoundsDonated)}</div>
    ${totalInboundPounds > 0
      ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">${Math.round((totalPoundsDonated / totalInboundPounds) * 100)}% of inbound</div>`
      : ""}
  </div>
  <div class="summary-pill out">
    <div class="label">${program ? `Outbound · ${escapeHtml(PROGRAM_LABEL[program])} cases` : "Outbound · total cases"}</div>
    <div class="value">${formatNum(totalOutbound)}</div>
    ${!program && programBreakdownEntries.length > 0
      ? `<div class="muted" style="font-size: 11px; margin-top: 4px;">${programBreakdownEntries.map(([p, qty]) => `${escapeHtml(PROGRAM_LABEL[p])} ${formatNum(qty)}`).join(" · ")}</div>`
      : ""}
  </div>
  ${program
    ? `<div class="summary-pill"><div class="label">Showing</div><div class="value" style="font-size: 14px; line-height: 1.4;">Outbound for ${escapeHtml(PROGRAM_LABEL[program])}<br><span class="muted" style="font-size: 12px; font-weight: 400;">inbound is org-wide</span></div></div>`
    : ""}
</div>

<h2>Inbound pounds by ${bucketWord}</h2>
<div class="card">
  <div class="chart-wrap"><canvas id="inboundChart"></canvas></div>
</div>

<h2>Outbound cases by ${bucketWord}</h2>
<div class="card">
  <div class="chart-wrap"><canvas id="outboundChart"></canvas></div>
</div>

<h2>${view === "daily" ? "Daily" : "Weekly"} breakdown</h2>
<div class="card">
  <table>
    <thead>
      <tr>
        <th>Metric</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      <tr><th>${inboundPoundsLabel}</th>${inboundPoundsRow}</tr>
      <tr><th class="sub">↳ Pounds purchased</th>${poundsPurchasedRow}</tr>
      <tr><th class="sub">↳ Pounds donated</th>${poundsDonatedRow}</tr>
      <tr><th>Purchase price</th>${purchasePriceRow}</tr>
      <tr><th>${outboundCasesLabel}</th>${outboundCasesRow}</tr>
${programRows}
      <tr><th>Weight coverage</th>${coverageRow}</tr>
      <tr><th>Vendors</th>${vendorsRow}</tr>
      <tr><th>Top inbound items (lbs)</th>${topInRow}</tr>
      <tr><th>Top outbound items</th>${topOutRow}</tr>
      <tr><th>Inbound invoices</th>${invoicesRow}</tr>
      <tr><th>Outbound sessions</th>${sessionsRow}</tr>
    </tbody>
  </table>
</div>

<footer>${env.TENANT_SHORT} Inventory · Inbound + Outbound Delivery Logs · Auto-aggregated from Google Sheets</footer>

</main>

<div class="bucket-panel-backdrop" id="bucket-panel-backdrop"></div>
<aside class="bucket-panel" id="bucket-panel" aria-hidden="true">
  <div class="bucket-panel-header">
    <div>
      <h3 id="bucket-panel-title">—</h3>
      <div class="sub" id="bucket-panel-sub"></div>
    </div>
    <button class="bucket-panel-close" id="bucket-panel-close" type="button" aria-label="Close">×</button>
  </div>
  <div class="bucket-panel-body" id="bucket-panel-body">
    <div class="bucket-panel-empty">Click a value in the table or chart to see the slips behind it.</div>
  </div>
</aside>
${chatPanelHtml(env.TENANT_SHORT)}
</div>
</div>

<script>${CHAT_PANEL_JS}</script>
<script>
  const chartLabels = ${chartLabels};
  const inboundSeries = ${inboundSeries};
  const outboundSeries = ${outboundSeries};
  const bucketMeta = ${bucketMeta};
  const programParam = ${programParamJs};
  const tokenParam = ${tokenParamJs};
  const dashboardView = ${JSON.stringify(view)};

  const panel = document.getElementById('bucket-panel');
  const backdrop = document.getElementById('bucket-panel-backdrop');
  const panelTitle = document.getElementById('bucket-panel-title');
  const panelSub = document.getElementById('bucket-panel-sub');
  const panelBody = document.getElementById('bucket-panel-body');
  let panelReqId = 0;

  function closePanel() {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
  }

  function openPanelShell(direction, from, to) {
    const label = formatRange(from, to);
    panelTitle.textContent = (direction === 'inbound' ? 'Inbound slips' : 'Outbound sessions') + ' — ' + label;
    panelSub.textContent = 'Loading…';
    panelBody.innerHTML = '<div class="bucket-panel-loading">Loading…</div>';
    panel.classList.add('open');
    backdrop.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
  }

  function formatRange(from, to) {
    if (from === to) {
      const d = new Date(from + 'T00:00:00Z');
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }
    const a = new Date(from + 'T00:00:00Z');
    const b = new Date(to + 'T00:00:00Z');
    const am = a.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const bm = b.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    const ad = a.getUTCDate(), bd = b.getUTCDate();
    return am === bm ? (am + ' ' + ad + '–' + bd) : (am + ' ' + ad + ' – ' + bm + ' ' + bd);
  }

  function fmtNum(n) {
    if (!n) return '0';
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(1);
  }
  function fmtMoney(n) {
    if (!n || n <= 0) return '';
    return '$' + Math.round(n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function b64urlEncode(s) {
    const b64 = btoa(unescape(encodeURIComponent(s)));
    return b64.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  }

  const authQs = tokenParam ? '&token=' + encodeURIComponent(tokenParam) : '';

  function renderInbound(slips) {
    if (!slips.length) return '<div class="bucket-panel-empty">No inbound slips in this window.</div>';
    return slips.map(s => {
      const enc = s.photo_url ? b64urlEncode(s.photo_url) : null;
      const slipHref = enc ? ('/review/slip?slip=' + enc + authQs) : null;
      const photoHref = enc ? ('/review/photo?slip=' + enc + authQs) : null;
      const thumb = slipHref
        ? '<a class="bucket-item-thumb" href="' + slipHref + '" target="_blank" rel="noopener"><img loading="lazy" src="' + photoHref + '" alt=""></a>'
        : '<div class="bucket-item-thumb">no<br>photo</div>';
      const openLink = slipHref
        ? '<a href="' + slipHref + '" target="_blank" rel="noopener">Open in Review ›</a>'
        : '<span class="muted">' + esc(s.invoice_or_order_number || '(no reference)') + '</span>';
      const supplier = esc(s.supplier || 'unknown');
      const invoice = s.invoice_or_order_number ? ('#' + esc(s.invoice_or_order_number)) : '';
      const date = esc(s.delivery_date || '');
      const parts = [];
      if (s.total_pounds > 0) parts.push(fmtNum(s.total_pounds) + ' lbs');
      parts.push(s.line_count + ' line' + (s.line_count === 1 ? '' : 's'));
      if (s.unweighed_lines > 0) parts.push(s.unweighed_lines + ' unweighed');
      if (s.purchase_price > 0) parts.push(fmtMoney(s.purchase_price));
      const tags = [];
      if (s.is_donation) tags.push('<span class="bucket-tag donation">Donation</span>');
      if (s.unweighed_lines > 0) tags.push('<span class="bucket-tag warn">Missing weight</span>');
      return '<div class="bucket-item">'
        + thumb
        + '<div class="bucket-item-body">'
        +   '<div class="bucket-item-title">' + supplier + (invoice ? ' <span class="muted">' + invoice + '</span>' : '') + '</div>'
        +   '<div class="bucket-item-meta">' + date + '<span class="sep">·</span>' + parts.join(' <span class="sep">·</span> ') + '</div>'
        +   (tags.length ? '<div class="bucket-item-tags">' + tags.join('') + '</div>' : '')
        +   '<div class="bucket-item-meta">' + openLink + '</div>'
        + '</div>'
        + '</div>';
    }).join('');
  }

  function renderOutbound(sessions) {
    if (!sessions.length) return '<div class="bucket-panel-empty">No outbound sessions in this window.</div>';
    return sessions.map(s => {
      const sessEnc = s.session_key ? b64urlEncode(s.session_key) : null;
      const photoEnc = s.photo_url ? b64urlEncode(s.photo_url) : null;
      const sessHref = sessEnc ? ('/review/outbound/slip?slip=' + sessEnc + authQs) : null;
      const photoHref = photoEnc ? ('/review/photo?slip=' + photoEnc + authQs) : null;
      const link = sessHref
        ? '<a href="' + sessHref + '" target="_blank" rel="noopener">Open in Review ›</a>'
        : '';
      const thumb = photoHref && sessHref
        ? '<a class="bucket-item-thumb" href="' + sessHref + '" target="_blank" rel="noopener"><img loading="lazy" src="' + photoHref + '" alt=""></a>'
        : '<div class="bucket-item-thumb">' + esc(s.source) + '</div>';
      const program = s.program_type ? esc(s.program_type).replace(/_/g, ' ') : '—';
      const parts = [];
      if (s.total_cases > 0) parts.push(fmtNum(s.total_cases) + ' cases');
      parts.push(s.line_count + ' line' + (s.line_count === 1 ? '' : 's'));
      return '<div class="bucket-item">'
        + thumb
        + '<div class="bucket-item-body">'
        +   '<div class="bucket-item-title">' + esc(s.source) + ' <span class="muted">' + program + '</span></div>'
        +   '<div class="bucket-item-meta">' + esc(s.date || '') + '<span class="sep">·</span>' + parts.join(' <span class="sep">·</span> ') + '</div>'
        +   (link ? '<div class="bucket-item-meta">' + link + '</div>' : '')
        + '</div>'
        + '</div>';
    }).join('');
  }

  async function loadBucket(direction, from, to) {
    const myReq = ++panelReqId;
    openPanelShell(direction, from, to);
    const params = new URLSearchParams({ direction, from, to });
    if (programParam) params.set('program', programParam);
    if (tokenParam) params.set('token', tokenParam);
    try {
      const resp = await fetch('/dashboard/bucket?' + params.toString(), { credentials: 'same-origin' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (myReq !== panelReqId) return;
      if (direction === 'inbound') {
        panelSub.textContent = data.slips.length + ' slip' + (data.slips.length === 1 ? '' : 's');
        panelBody.innerHTML = renderInbound(data.slips);
      } else {
        panelSub.textContent = data.sessions.length + ' session' + (data.sessions.length === 1 ? '' : 's');
        panelBody.innerHTML = renderOutbound(data.sessions);
      }
    } catch (err) {
      if (myReq !== panelReqId) return;
      panelSub.textContent = 'Error';
      panelBody.innerHTML = '<div class="bucket-panel-empty">Failed to load: ' + esc(err.message || err) + '</div>';
    }
  }

  // Table cell clicks
  document.addEventListener('click', function(e) {
    const cell = e.target.closest ? e.target.closest('.bucket-cell') : null;
    if (!cell) return;
    const dir = cell.getAttribute('data-direction');
    const from = cell.getAttribute('data-from');
    const to = cell.getAttribute('data-to');
    if (!dir || !from || !to) return;
    loadBucket(dir, from, to);
  });

  document.getElementById('bucket-panel-close').addEventListener('click', closePanel);
  backdrop.addEventListener('click', closePanel);
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) closePanel();
  });

  function chartClick(direction) {
    return function(evt, elements, chart) {
      const els = elements && elements.length ? elements : (chart.getElementsAtEventForMode ? chart.getElementsAtEventForMode(evt, 'nearest', { intersect: false }, false) : []);
      if (!els || !els.length) return;
      const idx = els[0].index;
      const meta = bucketMeta[idx];
      if (!meta) return;
      loadBucket(direction, meta.from, meta.to);
    };
  }

  new Chart(document.getElementById('inboundChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: 'Inbound pounds',
        data: inboundSeries,
        borderColor: '#047857',
        backgroundColor: 'rgba(4, 120, 87, 0.1)',
        tension: 0.25,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: chartClick('inbound'),
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 13 } } },
        tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + c.parsed.y + ' lbs' } }
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Pounds' } },
        x: { grid: { display: false } }
      }
    }
  });

  new Chart(document.getElementById('outboundChart').getContext('2d'), {
    type: 'line',
    data: {
      labels: chartLabels,
      datasets: [{
        label: 'Outbound cases',
        data: outboundSeries,
        borderColor: '#b45309',
        backgroundColor: 'rgba(180, 83, 9, 0.1)',
        tension: 0.25,
        fill: true,
        pointRadius: 4,
        pointHoverRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      onClick: chartClick('outbound'),
      plugins: {
        legend: { position: 'top', labels: { boxWidth: 12, font: { size: 13 } } },
        tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + c.parsed.y + ' cases' } }
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Cases' } },
        x: { grid: { display: false } }
      }
    }
  });
</script>

</body>
</html>`;
}
