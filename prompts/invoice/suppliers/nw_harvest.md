Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- is_donation => true. Northwest Harvest is a food-bank distributor; its Warehouse Posted Shipments represent donated goods. Always set is_donation = true for this supplier unless the slip explicitly states the goods were purchased/invoiced (e.g., a price or 'PAID' total appears), in which case set false.
- These manifests have NO price/cost column. There is no unit cost on the slip, so set unit_cost to 0 (the literal number zero), not blank/null. (If a future variant does include a price/cost/amount column, extract the actual cost instead.)
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
