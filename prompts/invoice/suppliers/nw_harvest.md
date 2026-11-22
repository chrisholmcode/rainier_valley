Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- is_donation: Northwest Harvest is a food-bank distributor and these Warehouse Posted Shipments are donated goods. Set is_donation = true by default. Only set false if the slip explicitly indicates a purchase/sale (e.g., a price/total-owed column or 'INVOICE'/'PURCHASE' wording).
- unit_cost: These manifests have NO price or cost column. When no cost column is present (the normal case for this supplier), set unit_cost to 0 (not blank/null) for every line item. If a slip unexpectedly includes a cost column, use that value instead.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
