import type { DeliverySheetRow, EodSheetRow, ProgramType } from "./types.js";
import { SHARED_CSS, FONT_HEAD_LINKS } from "./ui-styles.js";
import { env } from "./config.js";

const PROGRAM_LABEL: Record<ProgramType, string> = {
  home_delivery: "Home Delivery",
  in_person_shopping: "In Person Shopping",
  pre_made_bags: "Pre Made Bags",
  unknown: "Unknown"
};

export type View = "daily" | "weekly";

export interface Bucket {
  key: string;
  startDate: string;
  endDate: string;
  inboundPounds: number;
  outboundCases: number;
  inboundWeighedRows: number;
  inboundUnweighedRows: number;
  vendors: string[];
  topInbound: Array<{ name: string; qty: number }>;
  topOutbound: Array<{ name: string; qty: number }>;
  invoiceCount: number;
  sessionCount: number;
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
  periods: number
): Bucket[] {
  const range = view === "daily" ? dailyRange(periods) : weeklyRange(periods);
  const buckets = new Map<string, Bucket>();
  for (const r of range) {
    buckets.set(r.key, {
      key: r.key,
      startDate: r.startDate,
      endDate: r.endDate,
      inboundPounds: 0,
      outboundCases: 0,
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
    if (lbs != null) {
      bucket.inboundPounds += lbs;
      bucket.inboundWeighedRows += 1;
    } else {
      bucket.inboundUnweighedRows += 1;
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

function coverageCell(bucket: Bucket): string {
  const total = bucket.inboundWeighedRows + bucket.inboundUnweighedRows;
  if (total === 0) return `<span class="muted">—</span>`;
  if (bucket.inboundUnweighedRows === 0) return `<span class="muted">${total}/${total}</span>`;
  return `<span class="num-out">${bucket.inboundWeighedRows}/${total}</span>`;
}

export type Range = "1w" | "4w";

interface ViewOption {
  view: View;
  range: Range;
}

function periodsFor(view: View, range: Range): number {
  if (view === "daily") return range === "1w" ? 7 : 28;
  return range === "1w" ? 1 : 4;
}

function exportWindowDays(range: Range): number {
  return range === "1w" ? 7 : 28;
}

function csvField(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function buildCsvExport(params: {
  range: Range;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  program: ProgramType | null;
}): { filename: string; csv: string } {
  const { range, inboundRows, outboundRows, program } = params;
  const days = exportWindowDays(range);
  const dates = dailyRange(days).map((r) => r.startDate);
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
    supplier: string;
    reference: string;
    category: string;
    program_type: string;
  }> = [];

  for (const r of inboundRows) {
    const d = r.delivery_date;
    if (!d || !dateSet.has(d)) continue;
    if (isFee(r.is_fee)) continue;
    rows.push({
      date: d,
      direction: "inbound",
      item: (r.item_name_normalized || r.item_name_raw || "").trim(),
      quantity: toNumber(r.quantity),
      unit: (r.unit ?? "").trim(),
      pounds: inboundPoundsFor(r),
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

  const header = ["date", "direction", "item", "quantity", "unit", "pounds", "supplier", "reference", "category", "program_type"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvField(r.date),
      csvField(r.direction),
      csvField(r.item),
      csvField(formatNum(r.quantity)),
      csvField(r.unit),
      csvField(r.pounds == null ? "" : formatNum(r.pounds)),
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

function rangeButtons(active: ViewOption, _token: string, program: ProgramType | null): string {
  const progParam = programSuffix(program);
  const opts: Array<{ label: string; range: Range }> = [
    { label: "1 week", range: "1w" },
    { label: "4 weeks", range: "4w" }
  ];
  return opts
    .map((o) => {
      const cls = o.range === active.range ? "btn active" : "btn";
      return `<a class="${cls}" href="?view=${active.view}&amp;range=${o.range}${progParam}">${o.label}</a>`;
    })
    .join("");
}

function viewButtons(active: ViewOption, _token: string, program: ProgramType | null): string {
  const progParam = programSuffix(program);
  const dailyCls = active.view === "daily" ? "btn active" : "btn";
  const weeklyCls = active.view === "weekly" ? "btn active" : "btn";
  return `
    <a class="${dailyCls}" href="?view=daily&amp;range=${active.range}${progParam}">Daily</a>
    <a class="${weeklyCls}" href="?view=weekly&amp;range=${active.range}${progParam}">Weekly</a>
  `;
}

function programButtons(active: ViewOption, _token: string, activeProgram: ProgramType | null): string {
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
      return `<a class="${cls}" href="?view=${active.view}&amp;range=${active.range}${progParam}">${o.label}</a>`;
    })
    .join("");
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

function rescueExportControl(): string {
  const opts = rescueMonthOptions();
  const first = opts[0];
  const optionHtml = opts
    .map((o) => `<option value="${o.value}" data-from="${o.from}" data-to="${o.to}">${o.label}</option>`)
    .join("") + `<option value="custom">Custom range…</option>`;
  return `
<span class="rescue-export">
  <select id="rescue-month" class="rescue-select">${optionHtml}</select>
  <span id="rescue-custom" class="rescue-custom" hidden>
    <input type="date" id="rescue-from" class="rescue-date">
    <span class="rescue-dash">→</span>
    <input type="date" id="rescue-to" class="rescue-date">
  </span>
  <a class="btn btn-export" id="rescue-export-btn" href="/export/grocery-rescue?from=${first.from}&amp;to=${first.to}" download>↓ Grocery rescue slips (Food Lifeline)</a>
</span>
<script>
(function(){
  var sel = document.getElementById('rescue-month');
  var custom = document.getElementById('rescue-custom');
  var fromEl = document.getElementById('rescue-from');
  var toEl = document.getElementById('rescue-to');
  var btn = document.getElementById('rescue-export-btn');
  function update(){
    var f, t;
    if (sel.value === 'custom') {
      custom.hidden = false;
      f = fromEl.value; t = toEl.value;
    } else {
      custom.hidden = true;
      var opt = sel.options[sel.selectedIndex];
      f = opt.getAttribute('data-from');
      t = opt.getAttribute('data-to');
    }
    if (f && t) {
      btn.href = '/export/grocery-rescue?from=' + encodeURIComponent(f) + '&to=' + encodeURIComponent(t);
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    } else {
      btn.removeAttribute('href');
      btn.style.pointerEvents = 'none';
      btn.style.opacity = '0.5';
    }
  }
  sel.addEventListener('change', update);
  fromEl.addEventListener('change', update);
  toEl.addEventListener('change', update);
  update();
})();
</script>`;
}

export function buildDashboardHtml(params: {
  view: View;
  range: Range;
  program: ProgramType | null;
  token: string;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  generatedAt: Date;
}): string {
  const { view, range, program, token, inboundRows, outboundRows, generatedAt } = params;
  const periods = periodsFor(view, range);
  const buckets = aggregate(inboundRows, outboundRows, view, periods);
  const generatedLabel = generatedAt.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  const colHeaderFn = view === "daily" ? dailyColHeader : weeklyColHeader;
  const headerCells = buckets.map((b) => `<th>${colHeaderFn(b)}</th>`).join("");
  const inboundPoundsRow = buckets.map((b) => `<td class="num">${metricCell(b.inboundPounds, "in")}</td>`).join("");
  const outboundCasesRow = buckets.map((b) => `<td class="num">${metricCell(b.outboundCases, "out")}</td>`).join("");
  const coverageRow = buckets.map((b) => `<td class="num">${coverageCell(b)}</td>`).join("");
  const vendorsRow = buckets.map((b) => `<td>${vendorsCell(b.vendors)}</td>`).join("");
  const topInRow = buckets.map((b) => `<td>${itemsCell(b.topInbound)}</td>`).join("");
  const topOutRow = buckets.map((b) => `<td>${itemsCell(b.topOutbound)}</td>`).join("");
  const invoicesRow = buckets.map((b) => `<td class="num">${b.invoiceCount || `<span class="muted">0</span>`}</td>`).join("");
  const sessionsRow = buckets.map((b) => `<td class="num">${b.sessionCount || `<span class="muted">0</span>`}</td>`).join("");

  const chartLabels = JSON.stringify(buckets.map((b) => chartLabel(b, view)));
  const inboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.inboundPounds * 10) / 10));
  const outboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.outboundCases * 10) / 10));

  const totalInboundPounds = buckets.reduce((s, b) => s + b.inboundPounds, 0);
  const totalOutbound = buckets.reduce((s, b) => s + b.outboundCases, 0);

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

  const active: ViewOption = { view, range };
  const periodWord = view === "daily" ? (periods === 1 ? "day" : "days") : (periods === 1 ? "week" : "weeks");
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

.rescue-export { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.rescue-select, .rescue-date {
  font-family: inherit; font-size: 13px; font-weight: 500;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--line); border-radius: var(--radius-md);
  padding: 7px 10px; line-height: 1;
}
.rescue-select { padding-right: 24px; }
.rescue-custom { display: inline-flex; gap: 6px; align-items: center; }
.rescue-custom[hidden] { display: none; }
.rescue-dash { color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="container">

<header class="page">
  <div>
    <h1>${env.TENANT_SHORT} Dashboard</h1>
    <div class="meta">Last ${periods} ${periodWord} · Generated ${escapeHtml(generatedLabel)} PT</div>
  </div>
  <div class="toolbar">
    <div class="btn-group">${viewButtons(active, token, program)}</div>
    <div class="btn-group">${rangeButtons(active, token, program)}</div>
    <div class="btn-group">${programButtons(active, token, program)}</div>
    <a class="btn btn-export" href="?view=${view}&amp;range=${range}&amp;format=csv${programSuffix(program)}" download>↓ Export CSV</a>
    ${rescueExportControl()}
    <a class="btn" href="/review">Review queue →</a>
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
      <tr><th>${outboundCasesLabel}</th>${outboundCasesRow}</tr>
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

</div>

<script>
  const chartLabels = ${chartLabels};
  const inboundSeries = ${inboundSeries};
  const outboundSeries = ${outboundSeries};

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
