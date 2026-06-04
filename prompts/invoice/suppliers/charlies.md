Supplier: Charlie's Produce (Seattle, WA).
Document format: Customer invoice with columns ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION.
- Use SHIP quantity for inventory count.
- ITEM# => item_code_raw
- PACK SIZE => pack_size_raw (e.g., "1 40CT", "1 25LB")
- Descriptions use commas: "AVOCADO,HASS GREEN" not spaces.
- Origin codes may appear: MX (Mexico), UCA, etc. - put in notes.
- delivery_date: Use the **INVOICE DATE** field (or "INVOICED") in the upper-right header row, typically next to ACCOUNT# and INVOICE#. Format is usually MM/DD/YY — convert to YYYY-MM-DD. Do NOT leave delivery_date null when this field is visible.
- invoice_or_order_number: Use the **INVOICE#** column value in the upper-right header row (between ACCOUNT# and INVOICE DATE). Typically a 7-digit number like "7172545". Do NOT leave null when visible.
- Filter out: Energy charge (put in fees[] array)
- CHECK marks (/) in SHIP column indicate verification.
