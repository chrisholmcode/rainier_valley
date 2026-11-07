Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- is_donation: Northwest Harvest is a hunger-relief (food bank) organization, and its posted shipments are donated goods. Set is_donation => true by default for this supplier. Only set it to false if the slip clearly shows this is a priced purchase (e.g., unit prices, an invoice total, or payment/PO terms indicating a sale).
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
