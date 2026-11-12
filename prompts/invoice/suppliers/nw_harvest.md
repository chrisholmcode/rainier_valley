Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
- unit_cost: These Posted Shipment manifests have NO price/cost column (internal warehouse transfers). Always set unit_cost to 0 for every line item — never leave it blank/null.
- is_donation: Northwest Harvest is a hunger-relief food bank and its Warehouse Posted Shipments are donated goods — set is_donation = true by default. Only set false if the slip explicitly shows a purchase/payment (e.g., a price, invoice total, or "SOLD TO"/"amount due" terms).
