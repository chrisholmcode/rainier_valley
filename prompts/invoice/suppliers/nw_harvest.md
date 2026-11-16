Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- is_donation: Northwest Harvest is a hunger-relief/food-bank supplier; its Warehouse Posted Shipment manifests represent donated goods. Set is_donation = true by default, unless the slip explicitly indicates a purchase/sale (e.g., a price, invoice total, or "SOLD TO"/payment terms).
- No price/cost column exists on these manifests. Always set unit_cost to 0 (not blank/null) for every line item, unless a price column is actually present on the document.
- If image shows only a pallet label (no line items), add warning to source_warnings.
