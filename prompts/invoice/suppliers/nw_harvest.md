Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- is_donation: Northwest Harvest is a hunger-relief/food-bank org and these Posted Shipments are donation transfers. Set is_donation = true by default. Only set false if the slip explicitly shows a purchase price/charge (e.g., a non-zero Unit Price or Amount Due / invoice total).
- unit_cost: Warehouse Posted Shipment manifests have NO pricing/cost column. Always set unit_cost to 0 (not blank/null) for every line item on these documents. (Only extract a real cost if a priced invoice with a visible price/amount column is shown instead of a posted-shipment manifest.)
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
