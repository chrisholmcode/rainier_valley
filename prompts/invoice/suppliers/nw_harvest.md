Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- is_donation: Northwest Harvest is a hunger-relief distributor and these posted shipments represent donated goods. Default is_donation => true for this supplier. Only set false if the slip explicitly indicates a purchase/sale (e.g., a unit price, PO total, or "INVOICE"/"AMOUNT DUE" with a nonzero payable amount).
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
