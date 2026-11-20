Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- is_donation: Northwest Harvest is a hunger-relief distributor, and these posted shipments are donated goods unless the slip explicitly indicates a sale/purchase (e.g., a price/charge column, PO with payment terms, or "INVOICE"/"SALE" wording). Default is_donation = true. Set is_donation = false only when the document clearly shows the goods were purchased.
- If image shows only a pallet label (no line items), add warning to source_warnings.
