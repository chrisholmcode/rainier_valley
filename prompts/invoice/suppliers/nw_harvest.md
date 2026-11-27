Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- is_donation: Northwest Harvest is a hunger-relief/food-bank supplier; its Warehouse Posted Shipments are donated goods. Set is_donation = true by default. Only set false if the slip explicitly indicates a purchase/sale (e.g., unit prices, an invoice total, or "PAID"/payment terms).
- unit_cost: These manifests have no price/cost column (they are warehouse posted shipments of donated goods). Set unit_cost to 0 for every line — do not leave it blank/null. (If a future slip explicitly shows unit prices, use those instead and treat the slip as a purchase per the is_donation rule.)
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
