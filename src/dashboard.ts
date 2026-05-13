import type { DeliverySheetRow, EodSheetRow } from "./types.js";

export interface DayBucket {
  date: string;
  inboundCases: number;
  outboundCases: number;
  vendors: string[];
  topInbound: Array<{ name: string; qty: number }>;
  topOutbound: Array<{ name: string; qty: number }>;
  invoiceCount: number;
  sessionCount: number;
}

const TZ = "America/Los_Angeles";

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

function dateRange(days: number): string[] {
  const end = todayInTz();
  const [y, m, d] = end.split("-").map(Number);
  const endUtc = Date.UTC(y, m - 1, d);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(endUtc - i * 86400000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    out.push(`${yy}-${mm}-${dd}`);
  }
  return out;
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
  days: number
): DayBucket[] {
  const dates = dateRange(days);
  const buckets = new Map<string, DayBucket>();
  for (const date of dates) {
    buckets.set(date, {
      date,
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
    const d = r.delivery_date;
    if (!d || !buckets.has(d)) continue;
    if (isFee(r.is_fee)) continue;
    const qty = toNumber(r.quantity);
    const bucket = buckets.get(d)!;
    bucket.inboundCases += qty;

    if (r.supplier && r.supplier.trim()) {
      let vs = vendorSets.get(d);
      if (!vs) vendorSets.set(d, (vs = new Set()));
      vs.add(r.supplier.trim());
    }

    if (r.supplier && r.invoice_or_order_number) {
      let is = invoiceSets.get(d);
      if (!is) invoiceSets.set(d, (is = new Set()));
      is.add(`${r.supplier}::${r.invoice_or_order_number}`);
    }

    const name = (r.item_name_normalized || r.item_name_raw || "").trim();
    if (name && qty > 0) {
      let im = inboundItems.get(d);
      if (!im) inboundItems.set(d, (im = new Map()));
      im.set(name, (im.get(name) ?? 0) + qty);
    }
  }

  for (const r of outboundRows) {
    const d = r.date;
    if (!d || !buckets.has(d)) continue;
    const qty = toNumber(r.quantity);
    const bucket = buckets.get(d)!;
    bucket.outboundCases += qty;

    const sessionKey = r.slack_message_ts || `manual::${r.recorded_at || r.rowIndex}`;
    let ss = sessionSets.get(d);
    if (!ss) sessionSets.set(d, (ss = new Set()));
    ss.add(sessionKey);

    const name = (r.item_name_normalized || r.item_name_raw || "").trim();
    if (name && qty > 0) {
      let im = outboundItems.get(d);
      if (!im) outboundItems.set(d, (im = new Map()));
      im.set(name, (im.get(name) ?? 0) + qty);
    }
  }

  for (const date of dates) {
    const b = buckets.get(date)!;
    b.vendors = Array.from(vendorSets.get(date) ?? []).sort();
    b.invoiceCount = invoiceSets.get(date)?.size ?? 0;
    b.sessionCount = sessionSets.get(date)?.size ?? 0;
    b.topInbound = topN(inboundItems.get(date) ?? new Map(), 3);
    b.topOutbound = topN(outboundItems.get(date) ?? new Map(), 3);
  }

  return dates.map((d) => buckets.get(d)!);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatColHeader(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const weekday = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const monthDay = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `<div class="col-weekday">${escapeHtml(weekday)}</div><div class="col-date">${escapeHtml(monthDay)}</div>`;
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

export function buildDashboardHtml(params: {
  days: number;
  token: string;
  inboundRows: DeliverySheetRow[];
  outboundRows: EodSheetRow[];
  generatedAt: Date;
}): string {
  const { days, token, inboundRows, outboundRows, generatedAt } = params;
  const buckets = aggregate(inboundRows, outboundRows, days);
  const generatedLabel = generatedAt.toLocaleString("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  const headerCells = buckets.map((b) => `<th>${formatColHeader(b.date)}</th>`).join("");
  const inboundCasesRow = buckets.map((b) => `<td class="num">${casesCell(b.inboundCases, "in")}</td>`).join("");
  const outboundCasesRow = buckets.map((b) => `<td class="num">${casesCell(b.outboundCases, "out")}</td>`).join("");
  const vendorsRow = buckets.map((b) => `<td>${vendorsCell(b.vendors)}</td>`).join("");
  const topInRow = buckets.map((b) => `<td>${itemsCell(b.topInbound)}</td>`).join("");
  const topOutRow = buckets.map((b) => `<td>${itemsCell(b.topOutbound)}</td>`).join("");
  const invoicesRow = buckets.map((b) => `<td class="num">${b.invoiceCount || `<span class="muted">0</span>`}</td>`).join("");
  const sessionsRow = buckets.map((b) => `<td class="num">${b.sessionCount || `<span class="muted">0</span>`}</td>`).join("");

  const chartLabels = JSON.stringify(buckets.map((b) => {
    const [y, m, d] = b.date.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }));
  const inboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.inboundCases * 10) / 10));
  const outboundSeries = JSON.stringify(buckets.map((b) => Math.round(b.outboundCases * 10) / 10));

  const totalInbound = buckets.reduce((s, b) => s + b.inboundCases, 0);
  const totalOutbound = buckets.reduce((s, b) => s + b.outboundCases, 0);

  const tokenParam = encodeURIComponent(token);
  const btn7 = days === 7 ? "btn active" : "btn";
  const btn30 = days === 30 ? "btn active" : "btn";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RVFB Daily Dashboard</title>
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
  .toolbar { display: flex; gap: 8px; align-items: center; }
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
  h2 { font-size: 16px; margin: 24px 0 12px; letter-spacing: -0.01em; color: var(--muted); text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
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
    <h1>RVFB Daily Dashboard</h1>
    <div class="meta">Last ${days} days · Generated ${escapeHtml(generatedLabel)} PT</div>
  </div>
  <div class="toolbar">
    <a class="${btn7}" href="?days=7&amp;token=${tokenParam}">Last 7 days</a>
    <a class="${btn30}" href="?days=30&amp;token=${tokenParam}">Last 30 days</a>
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

<h2>Cases by day</h2>
<div class="card">
  <div class="chart-wrap"><canvas id="casesChart"></canvas></div>
</div>

<h2>Daily breakdown</h2>
<div class="card">
  <table>
    <thead>
      <tr>
        <th>Metric</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      <tr><th>Inbound — cases</th>${inboundCasesRow}</tr>
      <tr><th>Outbound — cases</th>${outboundCasesRow}</tr>
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
