---
name: rvfb-daily-report
description: Generate the Rainier Valley Food Bank daily inventory report (HTML + PDF) from the live "RVFB Inventory" Google Sheet, save both files to ~/Downloads, and match the leadership-update layout. Use when the user asks for the "RVFB daily report", "today's RVFB summary", "rvfb pdf", or anything that maps to producing the styled inbound + outbound recap.
tools: Read, Write, Bash, Grep, Glob, mcp__claude_ai_Google_Drive__search_files, mcp__claude_ai_Google_Drive__read_file_content, mcp__claude_ai_Google_Drive__download_file_content
---

# RVFB Daily Inventory Report

Produce a styled HTML + PDF daily report for Rainier Valley Food Bank, mirroring the leadership-update template, and save both files to `~/Downloads`.

## Inputs you need

- **Target date** — defaults to today in `America/Los_Angeles`. If the user names a different date, use theirs (ISO `YYYY-MM-DD`).
- **Spreadsheet** — `RVFB Inventory` (Google Sheet, `fileId = 15OyaSLwbPjSQ5lGhx5dH_PutW_BAR0uEku59jN61b5Y`). Two tabs:
  - `Inbound Delivery Log` — supplier invoices, schema in [references/data-format.md](references/data-format.md)
  - `Outbound Delivery Log` — whiteboard / EOD distribution, same file.

## Workflow

### 1. Resolve target date

Run `date '+%Y-%m-%d'` with `TZ=America/Los_Angeles`. That is the report date unless the user specified one.

### 2. Pull source data

Prefer fresh CSVs the user has already exported into `~/Downloads` (they sync faster than the MCP read), then fall back to the Sheet via MCP.

**Step A — check for fresh CSV exports.** Look for:

```
~/Downloads/RVFB Inventory - Inbound Delivery Log*.csv
~/Downloads/RVFB Inventory - Outbound Delivery Log*.csv
```

If the newest match for each tab was modified today, use those (read with `Grep` filtered to today's date). If either is missing or stale, continue.

**Step B — fall back to MCP Drive.** Call `mcp__claude_ai_Google_Drive__read_file_content` on `15OyaSLwbPjSQ5lGhx5dH_PutW_BAR0uEku59jN61b5Y`. The result is saved to a tool-results file (the response will name it). Extract content with:

```bash
jq -r '.fileContent' "<saved-tool-result-path>" > /tmp/rvfb_sheet.txt
```

Then use `Grep` with the target date (e.g. `2026-05-07`) on `/tmp/rvfb_sheet.txt`. The file is one long markdown-table dump — Inbound rows come first (24 columns including `supplier`, `delivery_date`, etc.), then a blank line, then Outbound rows (15 columns). The tab boundary is the only blank line.

**If MCP returns a truncation warning**, ask the user to export both tabs as CSV from Sheets (`File → Download → Comma Separated Values`) into `~/Downloads`, then retry from Step A. Do not silently proceed on partial data.

### 3. Aggregate data

See [references/data-format.md](references/data-format.md) for the exact column order and aggregation rules:

- **Inbound:** group by `(supplier, invoice_or_order_number)`. Within each group, separate fees (`is_fee = TRUE`) from line items, sum quantities, sum line totals (skip nulls), and flag rows with missing `unit_cost` / `line_total` or `confidence < 0.75`.
- **Outbound:** filter to today's `date`. Sort by `quantity` desc. Flag rows with `confidence < 0.85` as `low confidence`. Use `quantity_raw` or `notes` as the tally-detail string.

### 4. Render HTML

Use the template in [references/template.md](references/template.md). It contains the full HTML/CSS as a code block with placeholders (e.g. `{{LONG_DATE}}`, `{{INBOUND_CARD}}`, `{{INBOUND_SUPPLIERS}}`, `{{OUTBOUND_TABLE}}`). Substitute the aggregated values, then `Write` the result to:

```
~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.html
```

The template carries copy / styling / badge classes verbatim from the leadership template — do not redesign it. New flag types (e.g. "qty unclear") should reuse `<span class="badge warn">…</span>`.

### 5. Render PDF via headless Chrome

See [references/rendering.md](references/rendering.md) for the exact Chrome command. Output:

```
~/Downloads/rvfb_daily_summary_<YYYY-MM-DD>.pdf
```

### 6. Verify and report back

Confirm both files exist (`ls -la ~/Downloads/rvfb_daily_summary_<date>.*`), then summarize for the user:

- Inbound: total cases, line items, supplier breakdown, combined invoice value (flag if partial).
- Outbound: total cases, line items, source, low-confidence callouts.
- Any data-quality warnings the bot logged (`warnings_json` column).

## Edge cases

- **No inbound today** — render the summary card with `0 cases` and an empty-state line; replace the itemized section with a single-card "No inbound invoices were logged today" message. The outbound section still renders.
- **No outbound today** — mirror the above on the outbound side.
- **Both empty** — render the report anyway with both empty states; mention to the user that it's a no-activity day.
- **Missing invoice number** — use `"Invoice (no number captured)"` for that supplier's header.
- **Missing unit cost or line total** — show `—` in the cell and add a `badge warn` flag to the item name (`unit cost missing`, `line total missing`, or `cost / total missing`).
- **Quantity = 1 with line_total ≫ unit_cost × 5** — flag `qty unclear` (likely OCR misread).

## Reference files

- [references/data-format.md](references/data-format.md) — sheet schemas, aggregation rules, supplier label/origin mapping, category labels.
- [references/template.md](references/template.md) — the full HTML template with placeholder names.
- [references/rendering.md](references/rendering.md) — Chrome headless command, output path conventions.
