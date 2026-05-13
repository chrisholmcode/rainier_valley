import type { DeliverySheetRow, EodSheetRow } from "./types.js";

export type View = "daily" | "weekly";

export interface Bucket {
  key: string;
  startDate: string;
  endDate: string;
  inboundCases: number;
  outboundCases: number;
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
      inboundCases: 0,
      outboundCases: 0,
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
    const qty = toNumber(r.quantity);
    const bucket = buckets.get(key)!;
    bucket.inboundCases += qty;

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
    if (name && qty > 0) {
      let im = inboundItems.get(key);
      if (!im) inboundItems.set(key, (im = new Map()));
      im.set(name, (im.get(name) ?? 0) + qty);
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

function casesCell(n: number, kind: "in" | "out"): string {
  if (n === 0) return `<span class="muted">0</span>`;
  return `<span class="num-${kind}">${formatNum(n)}</span>`;
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
}): { filename: string; csv: string } {
  const { range, inboundRows, outboundRows } = params;
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
    supplier: string;
    reference: string;
    category: string;
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
      supplier: (r.supplier ?? "").trim(),
      reference: (r.invoice_or_order_number ?? "").trim(),
      category: (r.category ?? "").trim()
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
      supplier: "",
      reference: r.slack_message_ts ?? "",
      category: (r.category ?? "").trim()
    });
  }

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    if (a.direction !== b.direction) return a.direction === "inbound" ? -1 : 1;
    return a.item.localeCompare(b.item);
  });

  const header = ["date", "direction", "item", "quantity", "unit", "supplier", "reference", "category"];
  const lines = [header.join(",")];
  for (const r of rows) {
    lines.push([
      csvField(r.date),
      csvField(r.direction),
      csvField(r.item),
      csvField(formatNum(r.quantity)),
      csvField(r.unit),
      csvField(r.supplier),
      csvField(r.reference),
      csvField(r.category)
    ].join(","));
  }

  return {
    filename: `rvfb-export-${startDate}_to_${endDate}.csv`,
    csv: lines.join("\n") + "\n"
  };
}

function rangeButtons(active: ViewOption, token: string): string {
  const tokenParam = encodeURIComponent(token);
  const opts: Array<{ label: string; range: Range }> = [
    { label: "1 week", range: "1w" },
    { label: "4 weeks", range: "4w" }
  ];
  return opts
    .map((o) => {
      const cls = o.range === active.range ? "btn active" : "btn";
      return `<a class="${cls}" href="?view=${active.view}&amp;range=${o.range}&amp;token=${tokenParam}">${o.label}</a>`;
    })
    .join("");
}

function viewButtons(active: ViewOption, token: string): string {
  const tokenParam = encodeURIComponent(token);
  const dailyCls = active.view === "daily" ? "btn active" : "btn";
  const weeklyCls = active.view === "weekly" ? "btn active" : "btn";
  return `
    <a class="${dailyCls}" href="?view=daily&amp;range=${active.range}&amp;token=${tokenParam}">Daily</a>
    <a class="${weeklyCls}" href="?view=weekly&amp;range=${active.range}&amp;token=${tokenParam}">Weekly</a>
  `;
}

export function buildDashboardHtml(params: {
  view: View;
  range: Range;
  token: string;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  generatedAt: Date;
}): string {
  const { view, range, token, inboundRows, outboundRows, generatedAt } = params;
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
  const inboundCasesRow = buckets.map((b) => `<td class="num">${casesCell(b.inboundCases, "in")}</td>`).join("");
  const outboundCasesRow = buckets.map((b) => `<td class="num">${casesCell(b.outboundCases, "out")}</td>`).join("");
  const vendorsRow = buckets.map((b) => `<td>${vendorsCell(b.vendors)}</td>`).join("");
  const topInRow = buckets.map((b) => `<td>${itemsCell(b.topInbound)}</td>`).join("");
  const topOutRow = buckets.map((b) => `<td>${itemsCell(b.topOutbound)}</td>`).join("");
  const invoicesRow = buckets.map((b) => `<td class="num">${b.invoiceCount || `<span class="muted">0</span>`}</td>`).join("");
  const sessionsRow = buckets.map((b) => `<td class="num">${b.sessionCount || `<span class="muted">0</span>`}</td>`).join("");

  const chartLabels = JSON.stringify(buckets.map((b) => chartLabel(b, view)));
  const inboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.inboundCases * 10) / 10));
  const outboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.outboundCases * 10) / 10));

  const totalInbound = buckets.reduce((s, b) => s + b.inboundCases, 0);
  const totalOutbound = buckets.reduce((s, b) => s + b.outboundCases, 0);

  const active: ViewOption = { view, range };
  const periodWord = view === "daily" ? (periods === 1 ? "day" : "days") : (periods === 1 ? "week" : "weeks");
  const bucketWord = view === "daily" ? "day" : "week";
  const inboundCasesLabel = view === "daily" ? "Inbound — cases" : "Inbound — cases (week)";
  const outboundCasesLabel = view === "daily" ? "Outbound — cases" : "Outbound — cases (week)";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RVFB Dashboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #f7f7f5;
    --card: #ffffff;
    --ink: #1a1a1a;
    --muted: #6b7280;
    --line: #e5e7eb;
    --in: #047857;
    --in-bg: #ecfdf5;
    --out: #b45309;
    --out-bg: #fef3c7;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.5;
    font-size: 14px;
  }
  .container { max-width: 1400px; margin: 0 auto; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 2px solid var(--ink);
    padding-bottom: 16px;
    margin-bottom: 24px;
    flex-wrap: wrap;
    gap: 16px;
  }
  header h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  header .meta { color: var(--muted); font-size: 13px; }
  .toolbar { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  .btn-group { display: flex; gap: 6px; }
  .btn-group .divider { width: 1px; background: var(--line); align-self: stretch; margin: 0 4px; }
  .btn {
    display: inline-block;
    padding: 6px 14px;
    border: 1px solid var(--line);
    background: var(--card);
    color: var(--ink);
    border-radius: 999px;
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
  }
  .btn.active { background: var(--ink); color: #fff; border-color: var(--ink); }
  .btn:hover:not(.active) { background: #f3f4f6; }
  .btn-export { border-color: var(--in); color: var(--in); }
  .btn-export:hover { background: var(--in-bg); }
  h2 { font-size: 16px; margin: 24px 0 12px; color: var(--muted); text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
  .summary-row { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .summary-pill { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; min-width: 180px; }
  .summary-pill.in { border-left: 4px solid var(--in); }
  .summary-pill.out { border-left: 4px solid var(--out); }
  .summary-pill .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .summary-pill .value { font-size: 22px; font-weight: 700; letter-spacing: -0.02em; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .summary-pill.in .value { color: var(--in); }
  .summary-pill.out .value { color: var(--out); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; vertical-align: top; }
  thead th {
    text-align: center;
    background: #f3f4f6;
    border-bottom: 2px solid var(--line);
    font-weight: 600;
    font-size: 12px;
    color: var(--muted);
    position: sticky; top: 0;
  }
  thead th:first-child { text-align: left; }
  tbody th { text-align: left; font-weight: 600; background: #fafafa; color: var(--ink); white-space: nowrap; }
  .num { text-align: right; }
  .num-in { color: var(--in); font-weight: 700; }
  .num-out { color: var(--out); font-weight: 700; }
  .muted { color: var(--muted); font-weight: 400; }
  .col-weekday { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .col-date { font-size: 13px; font-weight: 600; color: var(--ink); }
  .chart-wrap { position: relative; height: 320px; }
  footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">

<header>
  <div>
    <h1>RVFB Dashboard</h1>
    <div class="meta">Last ${periods} ${periodWord} · Generated ${escapeHtml(generatedLabel)} PT</div>
  </div>
  <div class="toolbar">
    <div class="btn-group">${viewButtons(active, token)}</div>
    <div class="btn-group">${rangeButtons(active, token)}</div>
    <a class="btn btn-export" href="?view=${view}&amp;range=${range}&amp;format=csv&amp;token=${encodeURIComponent(token)}" download>↓ Export CSV</a>
  </div>
</header>

<div class="summary-row">
  <div class="summary-pill in">
    <div class="label">Inbound · total cases</div>
    <div class="value">${formatNum(totalInbound)}</div>
  </div>
  <div class="summary-pill out">
    <div class="label">Outbound · total cases</div>
    <div class="value">${formatNum(totalOutbound)}</div>
  </div>
  <div class="summary-pill">
    <div class="label">Net (in − out)</div>
    <div class="value">${formatNum(totalInbound - totalOutbound)}</div>
  </div>
</div>

<h2>Cases by ${bucketWord}</h2>
<div class="card">
  <div class="chart-wrap"><canvas id="casesChart"></canvas></div>
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
      <tr><th>${inboundCasesLabel}</th>${inboundCasesRow}</tr>
      <tr><th>${outboundCasesLabel}</th>${outboundCasesRow}</tr>
      <tr><th>Vendors</th>${vendorsRow}</tr>
      <tr><th>Top inbound items</th>${topInRow}</tr>
      <tr><th>Top outbound items</th>${topOutRow}</tr>
      <tr><th>Inbound invoices</th>${invoicesRow}</tr>
      <tr><th>Outbound sessions</th>${sessionsRow}</tr>
    </tbody>
  </table>
</div>

<footer>RVFB Inventory · Inbound + Outbound Delivery Logs · Auto-aggregated from Google Sheets</footer>

</div>

<script>
  const ctx = document.getElementById('casesChart').getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: ${chartLabels},
      datasets: [
        {
          label: 'Inbound cases',
          data: ${inboundSeries},
          borderColor: '#047857',
          backgroundColor: 'rgba(4, 120, 87, 0.1)',
          tension: 0.25,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6
        },
        {
          label: 'Outbound cases',
          data: ${outboundSeries},
          borderColor: '#b45309',
          backgroundColor: 'rgba(180, 83, 9, 0.1)',
          tension: 0.25,
          fill: true,
          pointRadius: 4,
          pointHoverRadius: 6
        }
      ]
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
