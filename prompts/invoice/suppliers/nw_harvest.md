Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Northwest Harvest is a hunger-relief/food-bank distributor; these Warehouse Posted Shipments are donated, no-cost transfer documents. Set is_donation => true and set unit_cost => 0 (an explicit zero, not blank/null) for every line. EXCEPTION: if the slip explicitly indicates a purchase/sale (e.g., prices, invoice totals, "SOLD TO", payment terms), set is_donation => false and use the printed unit prices instead of 0.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
