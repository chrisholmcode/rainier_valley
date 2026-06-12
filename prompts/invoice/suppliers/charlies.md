Supplier: Charlie's Produce (Seattle, WA).
Document format: Customer invoice with columns ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION.

COLUMN GUIDE (critical — read carefully):
- ORDER: cases ordered. NOT the quantity.
- SHIP: cases actually shipped. **This is the ONLY column to use for quantity.** Small integers (typically 1–30). unit = "case".
- APPROX.WT.: approximate weight in pounds (e.g., 20.00, 40.00, 50.00). **NEVER use this as quantity.** It is a decimal weight, sits immediately to the right of DESCRIPTION, and is the most common extraction mistake on this format. Put it in notes if useful, otherwise ignore.
- PRICE: per-case price => unit_cost.
- EXTENSION: line total => line_total.

ROW ALIGNMENT WARNING: ITEM# values wrap to two lines (e.g., "040-04232" with "UOR ORG" beneath), which makes ORDER/SHIP numbers appear vertically offset — often one line ABOVE the matching DESCRIPTION. Match rows by reading left-to-right along the same logical line item, not by strict vertical alignment.

SELF-CHECK before submitting (do this for every line item):
1) quantity × PRICE should equal EXTENSION (within rounding). If your quantity fails this check but EXTENSION ÷ PRICE is a clean small integer, you grabbed the wrong column — use that integer.
2) The bottom of the invoice prints "TOTAL CASES/TOTAL WEIGHT" (e.g., "79  2400.00"). Sum of your quantities should equal TOTAL CASES. If it instead equals TOTAL WEIGHT, you used APPROX.WT. — redo with SHIP.

Other rules:
- ITEM# => item_code_raw
- PACK SIZE => pack_size_raw (e.g., "1 40CT", "1 25LB"). Note "1 50LB" is pack size, not quantity or weight column.
- Descriptions use commas: "AVOCADO,HASS GREEN" not spaces.
- Origin codes may appear: MX (Mexico), UCA, UOR, UWA, CA, GT, etc. — put in notes.
- delivery_date: Use the **INVOICED** date field in the upper-right header row, next to ACCOUNT# and INVOICE#. Convert MM/DD/YY(YY) to YYYY-MM-DD. Do NOT leave delivery_date null when this field is visible.
- invoice_or_order_number: Use the **INVOICE#** value in the upper-right header row. Do NOT leave null when visible.
- Filter out: Energy charge (put in fees[] array)
- CHECK marks (/) in SHIP column indicate verification.
