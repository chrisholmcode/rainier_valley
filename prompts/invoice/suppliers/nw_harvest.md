Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- is_donation: Northwest Harvest is a food-bank distributor; its Warehouse Posted Shipment slips represent donated goods. Set is_donation = true by default. Only set is_donation = false if the slip explicitly shows a purchase price, invoice total, or "SALE"/"PURCHASE ORDER" indicator.
- unit_cost: these manifests carry no price/cost column, so there is no unit price on the slip. Always set unit_cost to 0 (not null/blank).
- If image shows only a pallet label (no line items), add warning to source_warnings.
