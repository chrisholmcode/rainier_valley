Supplier: Charlie's Produce (Seattle, WA).
Document format: Customer invoice with columns ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION.
- ORDER column => quantity_ordered. SHIP column => quantity (authoritative inventory count). Capture both — when SHIP < ORDER the supplier shorted the order and we need that visible.
- **approx_weight is REQUIRED whenever it can be recovered.** Rules, in priority order:
  1. If the APPROX.WT. column is legible for this line, use that value directly (total pounds for the line; numeric, no units).
  2. Otherwise (column blurred, missing, or blank), derive from the PACK SIZE. Charlie's pack notation is `M NLB` (units-per-case, then weight-per-unit) or `M NCT` (count-only, no weight). Rules:
     - Pack `1 25LB`, `1 40LB`, `1 50LB`, `1 11LB`, `1 21LB` => N lb per case. approx_weight = quantity × N.
     - Pack `M NLB` where M > 1 (e.g., `4 15LB`, `6 10LB`) => M × N lb per case. approx_weight = quantity × M × N.
     - Pack ending in `CT` with no LB (e.g., `1 40CT`, `1 60CT`, `12 9CT`, `5 8/CT`, `8 JCT`) => count-only. Set approx_weight = null (do NOT guess piece weights). Note in `notes`: "count-only pack, no weight derivable".
  3. If neither APPROX.WT. nor pack yields a weight, set approx_weight = null and explain in `notes`.
  - Worked example: 6 cases of `POTATO,RUSSET #2 IM` with pack `1 25LB` and blurred APPROX.WT. → approx_weight = 6 × 1 × 25 = 150.
  - Worked example: 25 cases of `SPECIAL,BANANA CTN` with pack `6 10LB` and blurred APPROX.WT. → approx_weight = 25 × 6 × 10 = 1500.
- ITEM# => item_code_raw
- PACK SIZE => pack_size_raw (e.g., "1 40CT", "1 25LB")
- Descriptions use commas: "AVOCADO,HASS GREEN" not spaces.
- Origin codes may appear: MX (Mexico), UCA, etc. - put in notes.
- delivery_date and invoice_date: Charlie's invoices carry a single date, labeled **INVOICE DATE** (or "INVOICED") in the upper-right header row, typically next to ACCOUNT# and INVOICE#. Format is usually MM/DD/YY — convert to YYYY-MM-DD and populate BOTH `invoice_date` and `delivery_date` with that same value. Do NOT leave either null when this field is visible.
- invoice_or_order_number: Use the **INVOICE#** column value in the upper-right header row (between ACCOUNT# and INVOICE DATE). Typically a 7-digit number like "7172545". Do NOT leave null when visible.
- Filter out: Energy charge (put in fees[] array)
- CHECK marks (/) in SHIP column indicate verification.
