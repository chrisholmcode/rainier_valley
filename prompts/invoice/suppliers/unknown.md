AUTO-DETECT SUPPLIER from the document. Look for these identifying features:

**Caruso's Produce** (set supplier: "carusos")
- Logo says "CARUSO" or "Caruso Produce"
- Location: Canby, OR or 2100 SE 4th Avenue
- Columns: ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT
- ORDERED => quantity_ordered. SHIPPED => quantity. Capture both. Filter out fuel surcharge.
- delivery_date: Use the **SHIP DATE** field in the upper-right header (NOT the "DATE" / invoice date field).

**Charlie's Produce** (set supplier: "charlies")
- Logo says "Charlie's Produce"
- Location: Seattle, WA or PO Box 24606 or 4123 2nd Ave S
- Columns: ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION
- Descriptions use commas (e.g., "AVOCADO,HASS GREEN"). ORDER => quantity_ordered. SHIP => quantity. APPROX.WT. => approx_weight (pounds). Capture all three. Filter out energy charge.
- delivery_date: Use the **INVOICE DATE** field in the upper-right header (next to ACCOUNT# / INVOICE#). Convert MM/DD/YY to YYYY-MM-DD.
- invoice_or_order_number: Use the **INVOICE#** value in the upper-right header (between ACCOUNT# and INVOICE DATE), typically a 7-digit number.

**Northwest Harvest / Food Lifeline** (set supplier: "nw_harvest")
- Header says "Northwest Harvest" or "Warehouse Posted Shipment" or "Food Lifeline"
- Location: Auburn warehouse
- Columns: Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight
- Weight column is TOTAL weight. Class Code = storage (AMBIENT/CHILL). Filter out Grand Totals row.
- If only a pallet label (no line items), add warning to source_warnings.

**Pacific Food Distributors** (set supplier: "pacific")
- Header says "Pacific Food Distributors"
- Bill of Lading format.

**The Weigelt Company** (set supplier: "weigelt")
- Header / logo says "THE WEIGELT COMPANY" (stylized "W"). NOTE: spelled "Weigelt" with a trailing **t** — distinct from any "Weigel" reference.
- Location: North Bend, WA (10511 428th Ave SE) or contact `Valerie@WeigeltCo.com`.
- Columns: # | Date | Product or service (SKU) | Description | Qty | Rate | Amount.
- Halal meat / poultry focus (ground beef, chicken thighs, drumsticks). Category should be "meat_protein" for all items unless clearly non-meat.
- Single Qty column => quantity (no separate ORDER column; leave quantity_ordered null). Qty may be fractional (e.g., 1480.5) — keep as-is.
- The bold number in the "Product or service" column (e.g., "012248", "111724345") => item_code_raw.
- Pack notation lives inside the Description (e.g., "12/1#-10cs", "12 pkgs/cs-10cs", "#8 Frozen-42cs"). Capture into pack_size_raw and keep in item_name_raw.
- delivery_date: Use the **Ship date** field in the "Shipping info" block (NOT "Invoice date" / "Due date").
- invoice_or_order_number: Use the **Invoice no.** value (e.g., "065315").
- No fuel surcharge / energy charge — leave fees[] empty unless one is explicitly visible.

If you cannot identify the supplier, set supplier to "unknown" and extract conservatively.
