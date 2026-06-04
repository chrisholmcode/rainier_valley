AUTO-DETECT SUPPLIER from the document. Look for these identifying features:

**Caruso's Produce** (set supplier: "carusos")
- Logo says "CARUSO" or "Caruso Produce"
- Location: Canby, OR or 2100 SE 4th Avenue
- Columns: ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT
- Use SHIPPED quantity. Filter out fuel surcharge.
- delivery_date: Use the **SHIP DATE** field in the upper-right header (NOT the "DATE" / invoice date field).

**Charlie's Produce** (set supplier: "charlies")
- Logo says "Charlie's Produce"
- Location: Seattle, WA or PO Box 24606 or 4123 2nd Ave S
- Columns: ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION
- Descriptions use commas (e.g., "AVOCADO,HASS GREEN"). Use SHIP quantity. Filter out energy charge.
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
- Bill of Lading format. May mention intermediary like "The Weigel Company LLC".

If you cannot identify the supplier, set supplier to "unknown" and extract conservatively.
