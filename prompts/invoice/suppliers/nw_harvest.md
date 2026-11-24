Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Northwest Harvest is a hunger-relief distributor; these Warehouse Posted Shipments are donation outflows of donated/distributed stock with NO price/cost column. Default is_donation => true and set unit_cost => 0 for every line (do NOT leave either blank/null). Only set is_donation false / use a real unit_cost if the slip clearly indicates a paid purchase (e.g., a price or amount-due total, or PO terms).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
