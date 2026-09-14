import type { DeliverySheetRow, Supplier } from "./types.js";
import { SHARED_CSS, FONT_HEAD_LINKS } from "./ui-styles.js";
import { encodeSlipKey } from "./review.js";
import { RESCUE_DONOR_CANONICAL } from "./extraction.js";
import { env } from "./config.js";

const RESCUE_DONOR_ORDER: string[] = [...RESCUE_DONOR_CANONICAL];

const RESCUE_DONOR_LABEL: Record<string, string> = {
  "QFC-MI":  "QFC · Mercer Island",
  "QFC-BWY": "QFC · Broadway",
  "SWY-RB":  "Safeway · Rainier Beach",
  "SWY-GEN": "Safeway · Genesee",
  "HG":      "Homegrown"
};

export const COVERAGE_SUPPLIERS: Supplier[] = [
  "grocery_rescue",
  "carusos",
  "charlies",
  "costco",
  "food_lifeline",
  "grand_central",
  "hayton_farms",
  "in_kind",
  "nw_harvest",
  "pacific",
  "terrebonne",
  "weigelt",
  "unknown"
];

const SUPPLIER_LABEL: Record<string, string> = {
  grocery_rescue: "Grocery Rescue",
  carusos: "Caruso's",
  charlies: "Charlie's",
  costco: "Costco",
  food_lifeline: "Food Lifeline",
  grand_central: "Grand Central",
  hayton_farms: "Hayton Farms",
  in_kind: "In-Kind",
  nw_harvest: "NW Harvest",
  pacific: "Pacific",
  terrebonne: "Terrebonne",
  weigelt: "Weigelt",
  unknown: "Unknown"
};

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

function ymd(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function defaultCoverageRange(): { from: string; to: string } {
  const to = todayInTz();
  const from = ymd(new Date(parseYmd(to).getTime() - 29 * 86400000));
  return { from, to };
}

function datesInRange(from: string, to: string): string[] {
  const start = parseYmd(from);
  const end = parseYmd(to);
  const days: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    days.push(ymd(new Date(t)));
  }
  return days;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDateHeader(dateStr: string): { weekday: string; monthDay: string } {
  const dt = parseYmd(dateStr);
  const weekday = dt.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const monthDay = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { weekday, monthDay };
}

interface Cell {
  count: number;
  slipUrl: string | null; // photo_url of one representative slip for the ✓ link
}

// Column key for a row. For grocery_rescue, group by donor_org (per-store).
// For every other supplier, collapse to a single "slip received" column.
function columnKeyFor(supplier: string, r: DeliverySheetRow): string {
  if (supplier === "grocery_rescue") {
    return (r.donor_org ?? "").trim() || "__unknown_donor__";
  }
  return "__all__";
}

export function buildCoverageHtml(params: {
  supplier: string;
  from: string;
  to: string;
  inboundRows: DeliverySheetRow[];
  generatedAt: Date;
}): string {
  const { supplier, from, to, inboundRows, generatedAt } = params;

  const filtered = inboundRows.filter((r) => {
    if ((r.supplier ?? "") !== supplier) return false;
    if (!r.delivery_date) return false;
    if (r.delivery_date < from || r.delivery_date > to) return false;
    return true;
  });

  // Discover columns present in the data (for grocery_rescue) so we don't hide
  // slips filed under an unrecognized donor_org.
  let columns: Array<{ key: string; label: string }>;
  if (supplier === "grocery_rescue") {
    const seen = new Set<string>();
    for (const r of filtered) seen.add(columnKeyFor(supplier, r));
    const extras = Array.from(seen)
      .filter((k) => !RESCUE_DONOR_ORDER.includes(k) && k !== "__unknown_donor__")
      .sort();
    const unknown = seen.has("__unknown_donor__") ? ["__unknown_donor__"] : [];
    columns = [
      ...RESCUE_DONOR_ORDER.map((k) => ({ key: k, label: RESCUE_DONOR_LABEL[k] ?? k })),
      ...extras.map((k) => ({ key: k, label: k })),
      ...unknown.map((k) => ({ key: k, label: "(no donor_org)" }))
    ];
  } else {
    columns = [{ key: "__all__", label: "Slip received" }];
  }

  const grid = new Map<string, Map<string, Cell>>();
  for (const r of filtered) {
    const date = r.delivery_date!;
    const col = columnKeyFor(supplier, r);
    let byCol = grid.get(date);
    if (!byCol) grid.set(date, (byCol = new Map()));
    let cell = byCol.get(col);
    if (!cell) byCol.set(col, (cell = { count: 0, slipUrl: null }));
    cell.count += 1;
    if (!cell.slipUrl && r.photo_url) cell.slipUrl = r.photo_url;
  }

  const dates = datesInRange(from, to).reverse(); // most recent up top

  const totalsByCol = new Map<string, number>();
  const slipsByCol = new Map<string, Set<string>>();
  for (const [date, byCol] of grid) {
    void date;
    for (const [col, cell] of byCol) {
      totalsByCol.set(col, (totalsByCol.get(col) ?? 0) + cell.count);
      if (cell.slipUrl) {
        let s = slipsByCol.get(col);
        if (!s) slipsByCol.set(col, (s = new Set()));
        s.add(cell.slipUrl);
      }
    }
  }

  const supplierOptions = COVERAGE_SUPPLIERS
    .map((s) => `<option value="${s}"${s === supplier ? " selected" : ""}>${escapeHtml(SUPPLIER_LABEL[s] ?? s)}</option>`)
    .join("");

  const headerCells = columns
    .map((c) => `<th class="col-donor">${escapeHtml(c.label)}</th>`)
    .join("");

  const bodyRows = dates.map((date) => {
    const byCol = grid.get(date);
    const { weekday, monthDay } = formatDateHeader(date);
    const rowCells = columns.map((c) => {
      const cell = byCol?.get(c.key);
      if (!cell || cell.count === 0) {
        return `<td class="cell empty" title="No slip received"><span class="gap">·</span></td>`;
      }
      const countLabel = cell.count > 1 ? ` <span class="cell-count">×${cell.count}</span>` : "";
      const check = `<span class="check">✓</span>${countLabel}`;
      if (cell.slipUrl) {
        const href = `/review/slip?slip=${encodeSlipKey(cell.slipUrl)}`;
        return `<td class="cell filled"><a href="${href}" title="Open slip">${check}</a></td>`;
      }
      return `<td class="cell filled">${check}</td>`;
    }).join("");
    return `<tr>
      <th class="row-date"><div class="col-weekday">${escapeHtml(weekday)}</div><div class="col-date">${escapeHtml(monthDay)}</div></th>
      ${rowCells}
    </tr>`;
  }).join("");

  const totalsRow = columns.map((c) => {
    const total = totalsByCol.get(c.key) ?? 0;
    const slips = slipsByCol.get(c.key)?.size ?? 0;
    if (total === 0) return `<td class="cell empty"><span class="muted">0</span></td>`;
    return `<td class="cell filled totals"><span class="totals-slips">${slips}</span><span class="totals-rows"> slip${slips === 1 ? "" : "s"}</span></td>`;
  }).join("");

  const totalDays = dates.length;
  const daysWithAny = Array.from(grid.values()).filter((m) => Array.from(m.values()).some((c) => c.count > 0)).length;
  const daysMissing = totalDays - daysWithAny;

  const generatedLabel = generatedAt.toLocaleString("en-US", {
    timeZone: TZ, month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${env.TENANT_SHORT} · Slip coverage</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>
${SHARED_CSS}
.coverage-toolbar { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 18px; }
.coverage-toolbar label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.coverage-toolbar select, .coverage-toolbar input[type=date] {
  font-family: inherit; font-size: 13px; font-weight: 500;
  color: var(--ink); background: var(--card);
  border: 1px solid var(--line); border-radius: var(--radius-md);
  padding: 7px 10px; line-height: 1;
}
.coverage-toolbar select { padding-right: 24px; }
.coverage-toolbar .presets { display: flex; gap: 6px; }
.coverage-card { overflow-x: auto; }
.coverage-card thead th { text-align: center; }
.coverage-card thead th.row-date-h { text-align: left; }
.coverage-card th.col-donor { min-width: 110px; font-size: 12px; }
.coverage-card th.row-date { text-align: left; white-space: nowrap; padding-right: 14px; }
.coverage-card .col-weekday { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.coverage-card .col-date    { font-size: 13px; font-weight: 600; color: var(--ink); }
.coverage-card td.cell { text-align: center; vertical-align: middle; padding: 10px 8px; }
.coverage-card td.cell.filled { background: rgba(4, 120, 87, 0.06); }
.coverage-card td.cell.filled a { text-decoration: none; color: inherit; display: inline-block; padding: 4px 8px; border-radius: 6px; }
.coverage-card td.cell.filled a:hover { background: rgba(4, 120, 87, 0.15); }
.coverage-card td.cell.empty { background: rgba(0,0,0,0.015); }
.coverage-card .check { color: #047857; font-weight: 700; font-size: 15px; }
.coverage-card .cell-count { color: var(--muted); font-size: 11px; font-weight: 600; margin-left: 2px; }
.coverage-card .gap { color: #cbd5e1; font-size: 18px; line-height: 1; }
.coverage-card tfoot td.cell { border-top: 2px solid var(--line); font-weight: 600; }
.coverage-card .totals-slips { color: var(--ink); font-weight: 700; }
.coverage-card .totals-rows  { color: var(--muted); font-weight: 500; font-size: 12px; }
.coverage-summary { display: flex; gap: 20px; color: var(--muted); font-size: 13px; margin-bottom: 12px; }
.coverage-summary .kpi strong { color: var(--ink); font-weight: 700; }
</style>
</head>
<body>
<div class="container">

<header class="page">
  <div>
    <h1>Slip coverage</h1>
    <div class="meta">Which delivery dates have we received a slip for · Generated ${escapeHtml(generatedLabel)} PT</div>
  </div>
  <div class="toolbar">
    <a class="btn" href="/dashboard">← Dashboard</a>
    <a class="btn" href="/review">Review queue →</a>
  </div>
</header>

<form class="coverage-toolbar" method="get" action="/coverage">
  <label>Supplier
    <select name="supplier">${supplierOptions}</select>
  </label>
  <label>From
    <input type="date" name="from" value="${escapeHtml(from)}">
  </label>
  <label>To
    <input type="date" name="to" value="${escapeHtml(to)}">
  </label>
  <button type="submit" class="btn btn-primary">Update</button>
  <span class="presets">
    <a class="btn" href="?supplier=${escapeHtml(supplier)}&amp;preset=7d">7d</a>
    <a class="btn" href="?supplier=${escapeHtml(supplier)}&amp;preset=30d">30d</a>
    <a class="btn" href="?supplier=${escapeHtml(supplier)}&amp;preset=90d">90d</a>
  </span>
</form>

<div class="coverage-summary">
  <div class="kpi"><strong>${daysWithAny}</strong> of ${totalDays} day${totalDays === 1 ? "" : "s"} have a slip</div>
  <div class="kpi"><strong>${daysMissing}</strong> day${daysMissing === 1 ? "" : "s"} with no slip</div>
</div>

<div class="card coverage-card">
  <table>
    <thead>
      <tr>
        <th class="row-date-h">Date</th>
        ${headerCells}
      </tr>
    </thead>
    <tbody>
      ${bodyRows}
    </tbody>
    <tfoot>
      <tr>
        <th class="row-date">Total</th>
        ${totalsRow}
      </tr>
    </tfoot>
  </table>
</div>

<footer>${env.TENANT_SHORT} Inventory · Slip coverage · Click ✓ to open the slip</footer>

</div>
</body>
</html>`;
}
