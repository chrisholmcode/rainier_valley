---
name: rvfb-weekly-report
description: Generate the Rainier Valley Food Bank weekly inventory report (HTML + PDF) from the live "RVFB Inventory" Google Sheet, save both files to ~/Downloads, and match the daily-report leadership layout but aggregated Sun–Sat. Use when the user asks for the "RVFB weekly report", "this week's RVFB summary", "rvfb weekly pdf", or anything that maps to producing a styled weekly inbound + outbound recap with day-by-day breakdown.
tools: Read, Write, Bash, Grep, Glob
---

# RVFB Weekly Inventory Report

Produce a styled HTML + PDF weekly report for Rainier Valley Food Bank covering a Sun–Sat week, mirroring the daily report's leadership layout, and save both files to `~/Downloads`.

This skill **reuses the daily skill's references** for data format and rendering:
- Sheet schemas, supplier label/origin mapping, category mapping, per-row flag rules: see `../rvfb-daily-report/references/data-format.md`.
- Chrome headless PDF command: see `../rvfb-daily-report/references/rendering.md`. Only the output filename pattern differs (see step 5 below).

Only the **template** and **aggregation period** are weekly-specific.

## Inputs you need

- **Week range** — defaults to the most recently completed week (Sun–Sat) ending **before** today. If the user says "this week", interpret as Sun-through-yesterday of the current week. If they give explicit dates ("week of May 24"), use those.
- **Spreadsheet** — `RVFB Inventory` (Google Sheet, `fileId = 15OyaSLwbPjSQ5lGhx5dH_PutW_BAR0uEku59jN61b5Y`).

## Workflow

### 1. Resolve the week

```bash
TZ=America/Los_Angeles date '+%Y-%m-%d %u'   # %u = ISO day (1=Mon … 7=Sun)
```

Weeks are **Sunday–Saturday** (matches the dashboard's `weeks start Sunday` decision). Compute `WEEK_START` (Sunday) and `WEEK_END` (Saturday) as ISO dates.

Defaults:
- If user said "this week" → `WEEK_START = most recent Sunday on/before today`, `WEEK_END = today` (partial week).
- If user said "last week" or didn't specify → `WEEK_START = Sunday 7 days before this week's Sunday`, `WEEK_END = the following Saturday` (most recently completed full week).

### 2. Pull source data

Same primary source as the daily report — the dashboard's raw JSON endpoint — but with `from` / `to` instead of `date`:

```bash
TOKEN=$(cat ~/.config/rvfb/dashboard_token)
WEEK_START=2026-05-24
WEEK_END=2026-05-30
curl -fsS "https://rainiervalley-production.up.railway.app/dashboard?format=raw&from=${WEEK_START}&to=${WEEK_END}&token=${TOKEN}" \
  > /tmp/rvfb_week_raw.json
jq '{from, to, inbound: (.inbound|length), outbound: (.outbound|length)}' /tmp/rvfb_week_raw.json
```

The JSON shape is `{ from, to, inbound: [...], outbound: [...] }`. Each row is the full sheet schema — same as daily.

**Fallback if the endpoint is down:** ask the user to export both tabs as CSV (`File → Download → Comma Separated Values`) into `~/Downloads`, then filter to the week's date range with `Grep`. Do NOT use `mcp__claude_ai_Google_Drive__read_file_content` — it truncates.

**Token storage:** `~/.config/rvfb/dashboard_token` (mode 0600). If missing, ask the user to retrieve it from Railway's `DASHBOARD_TOKEN` env var on the `rainier_valley` service.

### 3. Aggregate weekly metrics

All daily aggregation rules apply per row (fees, badge flags, missing financials, low confidence). On top of those, compute **weekly rollups**:

**Headline metrics (both cards):**
- `INBOUND_TOTAL_CASES` = sum of non-fee `quantity` across the entire week.
- `OUTBOUND_TOTAL_CASES` = sum of `quantity` across the entire week.
- `INBOUND_LINE_ITEMS` = count of non-fee inbound rows.
- `OUTBOUND_LINE_ITEMS` = count of outbound rows.
- `INBOUND_INVOICE_VALUE` = sum of `line_total` across all inbound rows (fees included); flag `(partial)` if any non-fee row has a null financial.
- `INBOUND_SUPPLIER_NAMES` = first-word labels (Caruso's, Charlie's, …) sorted by total cases desc.
- `INBOUND_SUPPLIER_COUNT` = distinct suppliers with ≥1 non-fee row.
- `OUTBOUND_CATEGORIES` = humanized category labels present, sorted by case volume desc.
- `DAYS_WITH_INBOUND` / `DAYS_WITH_OUTBOUND` = count of distinct dates with ≥1 row.
- `PRE_MADE_BAGS_CASES` = sum of `quantity` for outbound rows where `program_type == "pre_made_bags"`. Shown as a dedicated stat on the outbound card (renders as `0 cases` when none).

**Top-items lists (both cards):**
- Group rows by `item_name_normalized` (fall back to `item_name_raw`); sum `quantity`. Take top 10 per side, sort by qty desc. Format same as daily: `Potatoes (78), Onions (54), …` with each `(qty)` wrapped in `<span class="qty">…</span>`.

**Day-by-day breakdown (weekly-specific section):**

A 7-row table (Sun–Sat) with: date, weekday, inbound cases, outbound cases, net. Days with no activity render with `0` (not empty) so the week shape is visible. Highlight the row with the highest single-day outbound in muted bold.

**Top suppliers table:**

One row per supplier with non-fee inbound that week. Columns: supplier label, deliveries (distinct invoice numbers, treat empty as one bucket), cases, line items, combined invoice value (with `(partial)` flag if applicable). Sort by cases desc.

**All outbound items table:**

Every distinct outbound item from the week, no row limit. Columns: item, category (humanized), cases, days appeared. Sort by cases desc.

**All inbound items table:**

Every distinct inbound item from the week (non-fee rows only), no row limit. Columns: item, category (humanized), supplier(s) — comma-joined first-word labels sorted alphabetically (e.g. `Caruso's, Charlie's`) — cases, days appeared. Sort by cases desc. Group rows by `item_name_normalized` (fall back to `item_name_raw`).

**Data-quality footer:**
- `low_confidence_inbound_pct` = `low_confidence_inbound_rows / total_inbound_rows`. Same for outbound (threshold 0.85 outbound, 0.75 inbound — same as daily skill).
- `missing_financials_invoices` = distinct (supplier, invoice_number) groups with at least one non-fee null financial.

### 4. Render HTML

Use the template in [references/template.md](references/template.md). Substitute placeholders, then `Write` to:

```
~/Downloads/rvfb_weekly_summary_<WEEK_START>_to_<WEEK_END>.html
```

The template carries the same color tokens, badge classes, and card patterns as the daily template. Don't redesign — add weekly content into the established frame.

### 5. Render PDF via headless Chrome

Same Chrome command as the daily skill (see `../rvfb-daily-report/references/rendering.md`), just with the weekly filename:

```
~/Downloads/rvfb_weekly_summary_<WEEK_START>_to_<WEEK_END>.pdf
```

### 6. Verify and report back

`ls -la ~/Downloads/rvfb_weekly_summary_*` to confirm both files. Spot-check page 1 with `Read pages: "1-2"`. Then summarize for the user:

- Headline: total cases inbound, total cases outbound, net.
- Days with activity, busiest single day.
- Supplier mix (top 2–3 by volume).
- Top 3 inbound items, top 3 outbound items.
- Any data-quality callouts (% low confidence, # invoices with missing financials).

## Edge cases

- **No activity all week** — render the report with both empty-state summary cards and a single-line "No inbound or outbound activity recorded this week" message in place of the detail tables. Still produce the PDF.
- **Partial week (today is mid-week and user asked for "this week")** — note in the header subline (`Week-to-date through Thu, June 4`) and include a `<span class="note">(partial week)</span>` on the headline totals.
- **Multiple invoices same supplier same week** — list each as a separate row in the supplier table with its own invoice number; combine cases/total in a supplier subtotal row beneath.
- **Missing invoice number** — same handling as daily: treat empty-invoice rows as one bucket per supplier, label as `"Invoice (no number captured)"`.

## Reference files

- [references/template.md](references/template.md) — the weekly HTML template with placeholder names.
- `../rvfb-daily-report/references/data-format.md` — sheet schemas, per-row flag rules, supplier/category mappings (shared).
- `../rvfb-daily-report/references/rendering.md` — Chrome headless PDF command (shared; only filename differs).
