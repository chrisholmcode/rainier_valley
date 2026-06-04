# Weekly Report HTML Template

This is the canonical template for the RVFB weekly report. Substitute the `{{…}}` placeholders, then write the result to `~/Downloads/rvfb_weekly_summary_<WEEK_START>_to_<WEEK_END>.html`. The styling, color tokens, and badge classes mirror the daily template — keep them pinned.

## Placeholders

| Placeholder                  | Source                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `{{WEEK_LABEL}}`             | `Week of May 24 – May 30, 2026` (or `Week-to-date: May 31 – Jun 4, 2026`)    |
| `{{WEEK_SUBLINE}}`           | `Sun, May 24 → Sat, May 30` or `Partial week through Thu, Jun 4`             |
| `{{GENERATED_LABEL}}`        | Current PT time, e.g. `2:00 PM PT`                                           |
| `{{INBOUND_CARD}}`           | Weekly inbound summary card (snippet below)                                  |
| `{{OUTBOUND_CARD}}`          | Weekly outbound summary card (snippet below)                                 |
| `{{DAY_BY_DAY_TABLE}}`       | 7-row Sun–Sat table (snippet below)                                          |
| `{{SUPPLIER_TABLE}}`         | One row per supplier-invoice, sorted by cases desc (snippet below)           |
| `{{ALL_OUTBOUND_TABLE}}`     | All outbound items, sorted by cases desc (snippet below)                     |
| `{{ALL_INBOUND_TABLE}}`      | All inbound items, sorted by cases desc (snippet below)                      |
| `{{DATA_QUALITY_FOOTER}}`    | Low-confidence % and missing-financials count (snippet below)                |

## Full HTML

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RVFB Weekly Inventory Report — {{WEEK_LABEL}}</title>
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
    --accent: #1f2937;
    --warn: #b91c1c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 48px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif;
    background: var(--bg);
    color: var(--ink);
    line-height: 1.5;
    font-size: 15px;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    border-bottom: 2px solid var(--ink);
    padding-bottom: 20px;
    margin-bottom: 32px;
  }
  header h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
  header .meta { color: var(--muted); font-size: 14px; }
  header .meta strong { color: var(--ink); }
  h2 { font-size: 20px; margin: 40px 0 16px; letter-spacing: -0.01em; }
  h3 { font-size: 15px; margin: 0 0 8px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 8px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
  .card.in { border-left: 4px solid var(--in); }
  .card.out { border-left: 4px solid var(--out); }
  .stat { display: flex; justify-content: space-between; align-items: baseline; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .stat:last-child { border-bottom: none; }
  .stat-label { color: var(--muted); font-size: 13px; }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat.stack { display: block; padding: 10px 0; }
  .stat.stack .stat-label { display: block; margin-bottom: 6px; }
  .item-list { font-size: 13px; line-height: 1.7; font-variant-numeric: tabular-nums; color: var(--ink); font-weight: 500; }
  .item-list .qty { color: var(--muted); font-weight: 400; }
  .empty-state { color: var(--muted); font-size: 13px; font-style: italic; padding: 8px 0; }
  .big-number { font-size: 32px; font-weight: 700; letter-spacing: -0.02em; margin: 8px 0 4px; }
  .big-number.in { color: var(--in); }
  .big-number.out { color: var(--out); }
  .big-number.net { color: var(--accent); }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.in { background: var(--in-bg); color: var(--in); }
  .badge.out { background: var(--out-bg); color: var(--out); }
  .badge.warn { background: #fee2e2; color: var(--warn); margin-left: 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 10px 12px; background: #f3f4f6; border-bottom: 2px solid var(--line); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #fafafa; }
  .num { text-align: right; }
  .total-row { background: #fafafa; font-weight: 600; }
  .total-row td { border-top: 2px solid var(--ink); }
  .note { color: var(--muted); font-size: 13px; font-style: italic; }
  .peak-day td { font-weight: 600; background: #f9fafb; }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">

<header>
  <div>
    <h1>Rainier Valley Food Bank</h1>
    <div class="meta">Weekly Inventory Report</div>
  </div>
  <div class="meta">
    <div><strong>Week:</strong> {{WEEK_LABEL}}</div>
    <div>{{WEEK_SUBLINE}}</div>
    <div>Generated {{GENERATED_LABEL}}</div>
  </div>
</header>

<section>
  <h2>Week at a Glance</h2>
  <div class="summary-grid">
    {{INBOUND_CARD}}
    {{OUTBOUND_CARD}}
  </div>
</section>

<section>
  <h2>Day by Day</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Day</th>
          <th class="num"><span class="badge in">In</span> cases</th>
          <th class="num"><span class="badge out">Out</span> cases</th>
          <th class="num">Net</th>
        </tr>
      </thead>
      <tbody>
        {{DAY_BY_DAY_TABLE}}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2><span class="badge in">Inbound</span> by Supplier</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Supplier</th>
          <th>Invoice #</th>
          <th class="num">Deliveries</th>
          <th class="num">Line items</th>
          <th class="num">Cases</th>
          <th class="num">Invoice value</th>
        </tr>
      </thead>
      <tbody>
        {{SUPPLIER_TABLE}}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2><span class="badge out">Outbound</span> &mdash; All Items</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Category</th>
          <th class="num">Cases</th>
          <th class="num">Days appeared</th>
        </tr>
      </thead>
      <tbody>
        {{ALL_OUTBOUND_TABLE}}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2><span class="badge in">Inbound</span> &mdash; All Items</h2>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Item</th>
          <th>Category</th>
          <th>Supplier(s)</th>
          <th class="num">Cases</th>
          <th class="num">Days appeared</th>
        </tr>
      </thead>
      <tbody>
        {{ALL_INBOUND_TABLE}}
      </tbody>
    </table>
  </div>
</section>

{{DATA_QUALITY_FOOTER}}

<footer>
  Generated from RVFB Inventory spreadsheet · Inbound Delivery Log + Outbound Delivery Log · Source data: Slack photo extractions auto-logged via the RVFB bot.
</footer>

</div>
</body>
</html>
```

## Snippet — Inbound card (data present)

```html
<div class="card in">
  <h3><span class="badge in">Inbound</span> Deliveries Received</h3>
  <div class="big-number in">{{INBOUND_TOTAL_CASES}} cases{{PARTIAL_WEEK_NOTE_IF_ANY}}</div>
  <div class="stat"><span class="stat-label">Line items</span><span class="stat-value">{{INBOUND_LINE_ITEMS}}</span></div>
  <div class="stat"><span class="stat-label">Suppliers</span><span class="stat-value">{{INBOUND_SUPPLIER_COUNT}} ({{INBOUND_SUPPLIER_NAMES}})</span></div>
  <div class="stat"><span class="stat-label">Days with deliveries</span><span class="stat-value">{{DAYS_WITH_INBOUND}}</span></div>
  <div class="stat"><span class="stat-label">Combined invoice value</span><span class="stat-value">${{INBOUND_INVOICE_VALUE}}{{PARTIAL_FINANCIALS_NOTE_IF_ANY}}</span></div>
  <div class="stat stack">
    <span class="stat-label">Top items received</span>
    <div class="item-list">{{INBOUND_TOP_ITEMS}}</div>
  </div>
</div>
```

## Snippet — Outbound card (data present)

```html
<div class="card out">
  <h3><span class="badge out">Outbound</span> Distributed</h3>
  <div class="big-number out">{{OUTBOUND_TOTAL_CASES}} cases{{PARTIAL_WEEK_NOTE_IF_ANY}}</div>
  <div class="stat"><span class="stat-label">Line items</span><span class="stat-value">{{OUTBOUND_LINE_ITEMS}}</span></div>
  <div class="stat"><span class="stat-label">Days with distribution</span><span class="stat-value">{{DAYS_WITH_OUTBOUND}}</span></div>
  <div class="stat"><span class="stat-label">Busiest day</span><span class="stat-value">{{BUSIEST_OUTBOUND_DAY}}</span></div>
  <div class="stat"><span class="stat-label">Pre-made bags</span><span class="stat-value">{{PRE_MADE_BAGS_CASES}} cases</span></div>
  <div class="stat"><span class="stat-label">Categories</span><span class="stat-value">{{OUTBOUND_CATEGORIES}}</span></div>
  <div class="stat stack">
    <span class="stat-label">Top items distributed</span>
    <div class="item-list">{{OUTBOUND_TOP_ITEMS}}</div>
  </div>
</div>
```

## Snippet — Empty card variants

Use the same empty-state cards as the daily template, with `0 cases` and an italic empty-state line.

## Snippet — Day-by-day row

```html
<tr><td>{{ISO_DATE}}</td><td>{{WEEKDAY_LABEL}}</td><td class="num">{{DAY_INBOUND}}</td><td class="num">{{DAY_OUTBOUND}}</td><td class="num">{{DAY_NET}}</td></tr>
```

Highlight the row with the highest single-day outbound by adding `class="peak-day"` to the `<tr>`.

## Snippet — Supplier row

```html
<tr><td>{{SUPPLIER_LABEL}}</td><td>{{INVOICE_NUMBER_OR_LABEL}}</td><td class="num">{{DELIVERIES}}</td><td class="num">{{LINE_ITEMS}}</td><td class="num">{{CASES}}</td><td class="num">{{INVOICE_VALUE}}{{PARTIAL_NOTE_IF_ANY}}</td></tr>
```

After all supplier rows, append a total row:

```html
<tr class="total-row"><td colspan="3">All suppliers</td><td class="num">{{TOTAL_LINE_ITEMS}}</td><td class="num">{{TOTAL_CASES}}</td><td class="num">${{TOTAL_INVOICE_VALUE}}{{PARTIAL_NOTE_IF_ANY}}</td></tr>
```

## Snippet — Outbound item row

```html
<tr><td>{{ITEM_NAME}}{{FLAG_BADGES_IF_ANY}}</td><td>{{CATEGORY_LABEL}}</td><td class="num">{{CASES}}</td><td class="num">{{DAYS_APPEARED}}</td></tr>
```

## Snippet — Inbound item row

```html
<tr><td>{{ITEM_NAME}}{{FLAG_BADGES_IF_ANY}}</td><td>{{CATEGORY_LABEL}}</td><td>{{SUPPLIERS}}</td><td class="num">{{CASES}}</td><td class="num">{{DAYS_APPEARED}}</td></tr>
```

For both: group rows by `item_name_normalized` (fall back to `item_name_raw`), sum `quantity`, sort desc by cases. No row limit — list every distinct item that appeared in the week. For the inbound `SUPPLIERS` cell, render the supplier first-words (`Caruso's, Charlie's`) joined by `, ` and sorted alphabetically.

## Snippet — Data quality footer

Render this section only if there are quality flags worth surfacing. Otherwise omit entirely.

```html
<section>
  <h2>Data Quality</h2>
  <div class="card">
    <div class="stat"><span class="stat-label">Inbound low-confidence rate</span><span class="stat-value">{{INBOUND_LOW_CONF_PCT}}% ({{INBOUND_LOW_CONF_ROWS}} of {{INBOUND_TOTAL_ROWS}} rows)</span></div>
    <div class="stat"><span class="stat-label">Outbound low-confidence rate</span><span class="stat-value">{{OUTBOUND_LOW_CONF_PCT}}% ({{OUTBOUND_LOW_CONF_ROWS}} of {{OUTBOUND_TOTAL_ROWS}} rows)</span></div>
    <div class="stat"><span class="stat-label">Invoices with missing financials</span><span class="stat-value">{{MISSING_FINANCIAL_INVOICES}}</span></div>
  </div>
</section>
```

## Partial-week note conventions

When the report is for the in-progress current week (not a completed Sun–Sat):

- `{{PARTIAL_WEEK_NOTE_IF_ANY}}` on the big-number elements = ` <span class="note">(week-to-date)</span>`
- `{{WEEK_SUBLINE}}` = `Partial week through {{WEEKDAY}}, {{LONG_DATE}}`

Otherwise both are empty strings.
