# RVFB Sheet Schemas & Aggregation Rules

The RVFB Inventory spreadsheet has two tabs that drive the daily report.

## Inbound Delivery Log (24 columns)

```
created_at, supplier, document_type, delivery_date, invoice_or_order_number,
destination_org, item_code_raw, item_name_raw, item_name_normalized,
quantity, quantity_raw, unit, pack_size_raw, category, unit_cost, line_total,
confidence, is_fee, notes, photo_url, slack_channel, slack_message_ts,
uploaded_by, warnings_json
```

**Filter:** `delivery_date == <target_date>`. Do NOT filter by `created_at` — invoices are sometimes logged days after the actual delivery, and `delivery_date` is the authoritative ship/invoice date.

**Group by:** `(supplier, invoice_or_order_number)`. If `invoice_or_order_number` is empty, treat each supplier's empty-invoice rows as one group and label the section `"<Supplier> Produce — Invoice (no number captured)"`.

**Within each group:**
- Rows where `is_fee == TRUE` → fees (display as a single muted line: `<description> (fee, not inventory)` with `line_total` as the amount).
- Other rows → line items. Sort line items within a group by `quantity` desc.
- `unit_count = sum(quantity)` for non-fee rows only.
- `subtotal = sum(line_total)` including fees.
- `hasMissingFinancials = true` if any non-fee row has null `unit_cost` or null `line_total`. When true, append `(partial)` after the subtotal in muted italics.

**Per-row flags (badge warn pills):**
- `unit_cost == null && line_total == null` → `cost / total missing`
- `unit_cost == null` → `unit cost missing`
- `line_total == null` → `line total missing`
- `quantity == 1 && line_total > unit_cost * 5` → `qty unclear` (likely OCR caught only the leading "1" of a multi-digit quantity)
- `confidence > 0 && confidence < 0.75` → `low confidence`

**`warnings_json`** is a JSON array of free-text warnings the bot logged at extraction time. If non-empty for any row in a supplier group, render a yellow `supplier-warn` callout above that supplier's table:

> **Data-quality note:** Some fields could not be cleanly read from this invoice. Items below are flagged where individual values were missing or inconsistent.

(Don't dump the raw warning strings — they're often verbose and per-row.)

## Outbound Delivery Log (15 columns)

```
recorded_at, date, item_name_raw, item_name_normalized, quantity, quantity_raw,
unit, category, notes, confidence, source, slack_channel, slack_message_ts,
recorded_by, warnings_json
```

**Filter:** `date == <target_date>`.

**Sort:** by `quantity` desc.

**Tally detail string:** prefer `quantity_raw` (e.g. `"12cs + 3 loose strokes → written total = 20cs"`). Fall back to `notes` if `quantity_raw` is empty. If both are empty, use `—`.

**Flags:**
- `confidence > 0 && confidence < 0.85` → `low confidence` (note: outbound threshold is 0.85, higher than inbound, because whiteboard photos are noisier).

**Source label** for the table caption:
- If most rows have `source == "whiteboard"` → `"Source: Slack photo upload, <time PT>"`. Convert the earliest `slack_message_ts` to PT (e.g. `1:34 PM PT`).
- Otherwise → `"Source: <source>"` (`text`, `voice`, etc.).

**Categories** for the summary card: dedupe and humanize via the mapping below.

## Supplier label / origin mapping

| supplier code | label              | origin       |
| ------------- | ------------------ | ------------ |
| `carusos`     | Caruso's Produce   | Canby, OR    |
| `charlies`    | Charlie's Produce  | Seattle, WA  |
| `nw_harvest`  | Northwest Harvest  | Auburn, WA   |
| `pacific`     | Pacific Coast Fruit| Kent, WA     |
| `unknown`     | Unknown supplier   | (omit)       |

For the summary card "Suppliers" stat, use just the first word (`Caruso's`, `Charlie's`).

## Category mapping (outbound)

| category code   | label        |
| --------------- | ------------ |
| `produce`       | Produce      |
| `meat_protein`  | Protein      |
| `dairy`         | Dairy        |
| `shelf_stable`  | Shelf-stable |
| `frozen`        | Frozen       |
| `non_food`      | Bags         |
| `unknown`       | Other        |

## "All items" summary list (both cards)

A flat, comma-separated list sorted by quantity desc, formatted as:

```
Potatoes (26), Mangoes (24), Yellow Bell Peppers (22), …
```

In HTML each `(qty)` is wrapped in `<span class="qty">…</span>` (muted).
