Supplier: The Weigelt Company (North Bend, WA).
Document format: Printed invoice with columns # | Date | Product or service (SKU) | Description | Qty | Rate | Amount.
- Primarily halal meat and poultry (ground beef, chicken thighs, drumsticks). Set category to "meat_protein" for all line items unless clearly non-meat.
- Single quantity column: Qty => quantity. There is no separate ORDER column — leave quantity_ordered null.
- Qty may be a non-integer (e.g., 1480.5) — preserve as-is. **On Weigelt invoices Qty IS the billed weight in pounds** for every line item (ground beef, portioned chicken, everything). Set `unit = "lb"` and `approx_weight = quantity`. Do NOT recompute from the pack notation in the description.
- The bold SKU number to the LEFT of the description (e.g., "012248", "35006", "2470", "97971", "111724345") => item_code_raw. The "SKU" header column is usually empty.
- Description => item_name_raw (keep exact, e.g., "Halal ground beef 80/20- 12/1#-10cs").
- Pack notation lives inside the Description (e.g., "12/1#-10cs", "12 pkgs/cs, frozen-10cs", "24/1#-60cs", "#8 Frozen, 12 pkgs/cs-42cs"). Put the full pack/case notation in pack_size_raw and leave it in item_name_raw too.
- Normalize: "Halal ground beef 80/20" => "Halal Ground Beef 80/20"; "Chicken Thighs Boneless-Skinless Halal" => "Chicken Thighs, Boneless Skinless, Halal"; "Chicken Drumsticks, Halal, Frozen" => "Chicken Drumsticks, Halal"; "Ground beef" => "Ground Beef"; "Chicken Drums Tray Pack" => "Chicken Drumsticks, Tray Pack".
- Rate => unit_cost. Amount => line_total.
- delivery_date: Use the **Ship date** field in the "Shipping info" block. Convert MM/DD/YYYY to YYYY-MM-DD.
- invoice_date: Use the **Invoice date** field in the "Invoice details" block (NOT "Due date"). Convert MM/DD/YYYY to YYYY-MM-DD. Weigelt invoices always show both — capture both.
- invoice_or_order_number: Use the **Invoice no.** value in the "Invoice details" block (e.g., "065315").
- destination_org: "Rainier Valley Food Bank" (from the Bill to / Ship to block).
- totals.grand_total: Use the bold **Total** at the bottom of the invoice.
- No fuel surcharge / energy charge / delivery fee on Weigelt invoices — leave fees[] empty unless one is explicitly visible.
- Ignore the "Note to customer" line and the cryptographic "token=..." footer.
