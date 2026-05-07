# Report HTML Template

This is the canonical template for the RVFB daily report. Substitute the `{{…}}` placeholders, then write the result to `~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.html`. Do not redesign — copy/styling/badge classes are pinned to match the leadership update version.

## Placeholders

| Placeholder              | Source                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| `{{LONG_DATE}}`          | `May 7, 2026`                                                          |
| `{{WEEKDAY}}`            | `Thursday`                                                             |
| `{{GENERATED_LABEL}}`    | Current PT time, e.g. `2:00 PM PT`                                     |
| `{{INBOUND_CARD}}`       | Inbound summary card (see "Inbound card" snippet below)                |
| `{{OUTBOUND_CARD}}`      | Outbound summary card (see "Outbound card" snippet below)              |
| `{{INBOUND_SECTION}}`    | One supplier card per group (see "Supplier section" snippet below), or the empty-state card if there are no inbound rows |
| `{{OUTBOUND_SECTION}}`   | The whiteboard distribution card with table rows, or the empty-state card |

## Snippet — Inbound card (data present)

```html
<div class="card in">
  <h3><span class="badge in">Inbound</span> Deliveries Received</h3>
  <div class="big-number in">{{INBOUND_TOTAL_CASES}} cases</div>
  <div class="stat"><span class="stat-label">Line items</span><span class="stat-value">{{INBOUND_LINE_ITEMS}}</span></div>
  <div class="stat"><span class="stat-label">Suppliers</span><span class="stat-value">{{INBOUND_SUPPLIER_COUNT}} ({{INBOUND_SUPPLIER_NAMES}})</span></div>
  <div class="stat"><span class="stat-label">Combined invoice value</span><span class="stat-value">${{INBOUND_INVOICE_VALUE}}{{PARTIAL_NOTE_IF_ANY}}</span></div>
  <div class="stat stack">
    <span class="stat-label">All items received</span>
    <div class="item-list">{{INBOUND_ITEM_LIST}}</div>
  </div>
</div>
```

## Snippet — Inbound card (empty)

```html
<div class="card in">
  <h3><span class="badge in">Inbound</span> Deliveries Received</h3>
  <div class="big-number in">0 cases</div>
  <div class="stat"><span class="stat-label">Line items</span><span class="stat-value">0</span></div>
  <div class="stat"><span class="stat-label">Suppliers</span><span class="stat-value">—</span></div>
  <div class="stat"><span class="stat-label">Combined invoice value</span><span class="stat-value">$0.00</span></div>
  <div class="stat stack">
    <span class="stat-label">Status</span>
    <div class="empty-state">No inbound deliveries logged today.</div>
  </div>
</div>
```

## Snippet — Outbound card (data present)

```html
<div class="card out">
  <h3><span class="badge out">Outbound</span> Distributed</h3>
  <div class="big-number out">{{OUTBOUND_TOTAL_CASES}} cases</div>
  <div class="stat"><span class="stat-label">Line items</span><span class="stat-value">{{OUTBOUND_LINE_ITEMS}}</span></div>
  <div class="stat"><span class="stat-label">Source</span><span class="stat-value">Whiteboard tally</span></div>
  <div class="stat"><span class="stat-label">Categories</span><span class="stat-value">{{OUTBOUND_CATEGORIES}}</span></div>
  <div class="stat stack">
    <span class="stat-label">All items distributed</span>
    <div class="item-list">{{OUTBOUND_ITEM_LIST}}</div>
  </div>
</div>
```

## Snippet — Supplier section (one per inbound group)

```html
<div class="card supplier-section">
  <div class="supplier-header">
    <h3>{{SUPPLIER_LABEL}} — {{INVOICE_LABEL}}</h3>
    <div class="supplier-meta">Invoice date: {{DATE_SHORT}} · {{ORIGIN}}</div>
  </div>
  {{SUPPLIER_WARN_IF_ANY}}
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Pack</th>
        <th class="num">Qty</th>
        <th>Unit</th>
        <th class="num">Unit Cost</th>
        <th class="num">Line Total</th>
      </tr>
    </thead>
    <tbody>
      {{LINE_ITEM_ROWS}}
      {{FEE_ROWS}}
      <tr class="total-row"><td colspan="2">{{SUPPLIER_SHORT}} subtotal</td><td class="num">{{UNIT_COUNT}} units</td><td></td><td></td><td class="num">{{SUBTOTAL}}{{PARTIAL_NOTE_IF_ANY}}</td></tr>
    </tbody>
  </table>
</div>
```

Line item row:

```html
<tr><td>{{ITEM_NAME}}{{FLAG_BADGES}}</td><td>{{PACK}}</td><td class="num">{{QTY}}</td><td>{{UNIT}}</td><td class="num">{{UNIT_COST}}</td><td class="num">{{LINE_TOTAL}}</td></tr>
```

Fee row:

```html
<tr><td colspan="5" style="color:var(--muted)">{{FEE_DESCRIPTION}} (fee, not inventory)</td><td class="num">{{FEE_AMOUNT}}</td></tr>
```

Supplier warn callout (only when missing fields or warnings_json non-empty):

```html
<div class="supplier-warn"><strong>Data-quality note:</strong> Some fields could not be cleanly read from this invoice. Items below are flagged where individual values were missing or inconsistent.</div>
```

## Snippet — Outbound table (data present)

```html
<div class="card">
  <div class="supplier-header">
    <h3>Distribution day — recorded from whiteboard tally</h3>
    <div class="supplier-meta">{{OUTBOUND_SOURCE_LABEL}}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Category</th>
        <th class="num">Cases out</th>
        <th>Tally Detail</th>
      </tr>
    </thead>
    <tbody>
      {{OUTBOUND_ROWS}}
      <tr class="total-row"><td colspan="2">Total cases distributed</td><td class="num">{{OUTBOUND_TOTAL_CASES}}</td><td><span class="note">{{OUTBOUND_LINE_ITEMS}} line items · {{OUTBOUND_CATEGORIES_PLUS}}</span></td></tr>
    </tbody>
  </table>
</div>
```

Outbound row:

```html
<tr><td>{{ITEM_NAME}}{{FLAG_BADGES}}</td><td>{{CATEGORY}}</td><td class="num">{{CASES}}</td><td>{{TALLY_DETAIL}}</td></tr>
```

## Snippet — Empty-state card

```html
<div class="card">
  <div class="empty-state" style="text-align:center; padding: 24px 0;">
    No inbound invoices were logged today.
  </div>
</div>
```

(Use the same shape for an empty outbound section, swapping the message.)

## Full template document

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>RVFB Daily Inventory Report — {{LONG_DATE}}</title>
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
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
  .badge.in { background: var(--in-bg); color: var(--in); }
  .badge.out { background: var(--out-bg); color: var(--out); }
  .badge.warn { background: #fee2e2; color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; padding: 10px 12px; background: #f3f4f6; border-bottom: 2px solid var(--line); font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  td { padding: 10px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  tr:last-child td { border-bottom: none; }
  tr:hover { background: #fafafa; }
  .num { text-align: right; }
  .supplier-section { margin-bottom: 24px; }
  .supplier-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .supplier-header h3 { margin: 0; color: var(--ink); text-transform: none; font-size: 17px; letter-spacing: -0.01em; }
  .supplier-meta { color: var(--muted); font-size: 13px; }
  .supplier-warn { background: #fef3c7; border: 1px solid #fcd34d; color: #78350f; border-radius: 8px; padding: 10px 12px; font-size: 12px; margin-bottom: 12px; }
  .total-row { background: #fafafa; font-weight: 600; }
  .total-row td { border-top: 2px solid var(--ink); }
  .note { color: var(--muted); font-size: 13px; font-style: italic; }
  footer { margin-top: 56px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="container">

<header>
  <div>
    <h1>Rainier Valley Food Bank</h1>
    <div class="meta">Daily Inventory Report</div>
  </div>
  <div class="meta">
    <div><strong>Date:</strong> {{WEEKDAY}}, {{LONG_DATE}}</div>
    <div>Generated {{GENERATED_LABEL}}</div>
  </div>
</header>

<section>
  <h2>Today at a Glance</h2>
  <div class="summary-grid">
    {{INBOUND_CARD}}
    {{OUTBOUND_CARD}}
  </div>
</section>

<section>
  <h2><span class="badge in">Inbound</span> Itemized Deliveries</h2>
  {{INBOUND_SECTION}}
</section>

<section>
  <h2><span class="badge out">Outbound</span> Whiteboard Distribution</h2>
  {{OUTBOUND_SECTION}}
</section>

<footer>
  Generated from RVFB Inventory spreadsheet · Inbound Delivery Log + Outbound Delivery Log · Source data: Slack photo extractions auto-logged via the RVFB bot.
</footer>

</div>
</body>
</html>
```

## HTML escaping

Item names, supplier labels, notes, and tally-detail strings can contain `<`, `>`, `&`, `'`, `"`. Escape them before substitution.
