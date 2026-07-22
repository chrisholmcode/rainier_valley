AUTO-DETECT SUPPLIER from the document. Look for these identifying features:

**Caruso's Produce** (set supplier: "carusos")
- Logo says "CARUSO" or "Caruso Produce"
- Location: Canby, OR or 2100 SE 4th Avenue
- Columns: ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT
- ORDERED => quantity_ordered. SHIPPED => quantity. Capture both. Filter out fuel surcharge.
- delivery_date and invoice_date: Caruso's invoices carry a single date labeled **SHIP DATE**. Populate BOTH `invoice_date` and `delivery_date` with that value (YYYY-MM-DD).

**Charlie's Produce** (set supplier: "charlies")
- Logo says "Charlie's Produce"
- Location: Seattle, WA or PO Box 24606 or 4123 2nd Ave S
- Columns: ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION
- Descriptions use commas (e.g., "AVOCADO,HASS GREEN"). ORDER => quantity_ordered. SHIP => quantity. APPROX.WT. => approx_weight (pounds). Capture all three. Filter out energy charge.
- delivery_date and invoice_date: Charlie's invoices carry a single date labeled **INVOICE DATE** in the upper-right header (next to ACCOUNT# / INVOICE#). Convert MM/DD/YY to YYYY-MM-DD and populate BOTH `invoice_date` and `delivery_date` with that value.
- invoice_or_order_number: Use the **INVOICE#** value in the upper-right header (between ACCOUNT# and INVOICE DATE), typically a 7-digit number.

**Grand Central Bakery** (set supplier: "grand_central")
- Header says "Grand Central Bakery"
- Location: 21 S Nevada St, Seattle WA 98123
- Columns: Code | Description | Quantity | Unit Price | Ext. Price
- Single quantity column (no ORDER/SHIP split) => quantity. unit = "ea". Bread items => category "shelf_stable". approx_weight = null.
- delivery_date and invoice_date: Grand Central invoices carry a single **Date** field in the upper-right header. Convert to YYYY-MM-DD and populate BOTH `invoice_date` and `delivery_date` with that value.
- invoice_or_order_number: Use the **Invoice** value in the upper-right header.
- destination_org: Use the **Customer** field verbatim including any "- Donation" / "- Purchased" suffix.
- is_donation: read the Customer suffix — "- Donation" => true, "- Purchased" => false, otherwise null.

**Northwest Harvest** (set supplier: "nw_harvest")
- Header says "northwest HARVEST" with "Warehouse Posted Shipment" subtitle
- Location: Auburn warehouse
- Columns: Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight
- Weight column is TOTAL weight. Class Code = storage (AMBIENT/CHILL). Filter out Grand Totals row.
- If only a pallet label (no line items), add warning to source_warnings.

**Food Lifeline AGENCY ORDER** (set supplier: "food_lifeline")
- Printed manifest. "FOOD LIFELINE" logo + "AGENCY ORDER" header. Columns: Item No. | Description | Unit | Quantity | Cubic Feet | Unit Fee | Total Fee | Gross Weight. document_type = "manifest". donor_org = null. Quantity => quantity, Gross Weight => approx_weight. Item No. suffix `-TEFA` / `-CITY` => capture in notes. Populate BOTH invoice_date and delivery_date from Ship Date. invoice_or_order_number from Agency Order No. Totals are $0 (preserve as 0). is_donation = true.

**Grocery Rescue** (set supplier: "grocery_rescue")
- Handwritten Food Lifeline rescue slip. "FOOD LIFELINE" logo + form fields Donor / Address / Agency / Date. Per-category Pounds (lb) column. document_type = "manifest". donor_org = the Donor field mapped to one of QFC-MI / QFC-BWY / SWY-RB / SWY-GEN / HG. Populate BOTH invoice_date and delivery_date from the Date field (Donor/Date may be swapped — disambiguate by shape). One line item per non-empty Pounds row using the row label as item_name_raw, unit = "lb", approx_weight = parsed pounds. Apply the running-tally rule (see supplier prompt). Totals null. fees[] empty. is_donation = true.
- Also `supplier = "grocery_rescue"` when a printed invoice arrives from a rescue partner (QFC / Safeway / Homegrown) with per-line SKUs and prices — same donor bucket, printed layout.

**Costco Business Delivery** (set supplier: "costco")
- Header has the Costco / Costco Business Center logo and title "Invoice"
- Location: Whse 767, 3900 20th St E, Fife, WA (or similar Costco Business Center warehouse)
- Columns: Ordered | Shipped | Item | Description | Unit Price | Tax | Resale/Exempt | Instant Savings | Amount
- Ordered => quantity_ordered. Shipped => quantity. Capture both. Item column is the SKU => item_code_raw.
- delivery_date: Use the **Scheduled Delivery Date** field. invoice_date: Use the **Order Date** field. Costco invoices show both; capture each in its own column.
- invoice_or_order_number: Use the **Order Number** value.
- Pack notation lives at the end of the Description (e.g., `0.85 OZ, 64 CT`); derive approx_weight from `quantity × N × X / 16` when the pack has a weight unit.
- Section headers (Dry Items / Refrigerated / Frozen / Produce) tag the lines beneath them for category.
- Fees: Delivery Surcharge and Order Adjustment go in fees[] only when nonzero. Ignore "Instant Savings" and the rebate/cash back lines.

**Pacific Food Distributors** (set supplier: "pacific")
- Header says "Pacific Food Distributors"
- Bill of Lading format.

**Terrebonne Truck Patch** (set supplier: "terrebonne")
- Letterhead says "Terrebonne Truck Patch", North Bend WA. Hand-written carbon-copy invoice book with a printed "No. <NNN>" in the upper-right.
- Columns: Quantity | Description | Price | Amount. Single Quantity column => quantity. unit = "ea". approx_weight = null (count-only).
- delivery_date and invoice_date: Terrebonne invoices carry a single handwritten **Date** field (M-D-YY); convert to YYYY-MM-DD and populate BOTH `invoice_date` and `delivery_date` with that value.
- invoice_or_order_number: Use the printed **No.** value (e.g., "137").
- Category = "produce" for all items. is_donation = false.

**The Weigelt Company** (set supplier: "weigelt")
- Header / logo says "THE WEIGELT COMPANY" (stylized "W"). NOTE: spelled "Weigelt" with a trailing **t** — distinct from any "Weigel" reference.
- Location: North Bend, WA (10511 428th Ave SE) or contact `Valerie@WeigeltCo.com`.
- Columns: # | Date | Product or service (SKU) | Description | Qty | Rate | Amount.
- Halal meat / poultry focus (ground beef, chicken thighs, drumsticks). Category should be "meat_protein" for all items unless clearly non-meat.
- Single Qty column => quantity (no separate ORDER column; leave quantity_ordered null). Qty may be fractional (e.g., 1480.5) — keep as-is.
- The bold number in the "Product or service" column (e.g., "012248", "111724345") => item_code_raw.
- Pack notation lives inside the Description (e.g., "12/1#-10cs", "12 pkgs/cs-10cs", "#8 Frozen-42cs"). Capture into pack_size_raw and keep in item_name_raw.
- delivery_date: Use the **Ship date** field in the "Shipping info" block. invoice_date: Use the **Invoice date** field in the "Invoice details" block (NOT "Due date"). Weigelt invoices always show both.
- invoice_or_order_number: Use the **Invoice no.** value (e.g., "065315").
- No fuel surcharge / energy charge — leave fees[] empty unless one is explicitly visible.

If you cannot identify the supplier, set supplier to "unknown" and extract conservatively.
