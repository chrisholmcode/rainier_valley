Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column => quantity (authoritative case count). Northwest Harvest manifests do not have a separate ORDER column — leave quantity_ordered null.
- Weight column => approx_weight (TOTAL weight in pounds for the line, not per-unit).
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- unit_cost: This Warehouse Posted Shipment manifest has no price/cost column, so set unit_cost=0 (not blank/null). If a priced variant of this document appears with an actual cost column, use the listed price instead.
- is_donation: Northwest Harvest is a hunger-relief food bank, and its Warehouse Posted Shipments are donation distributions by default. Set is_donation=true unless the slip explicitly shows a purchase/payment indicator (e.g., a price/amount due, a PO with payment terms, or 'INVOICE'/'SALE' wording). If such a purchase indicator is present, set is_donation=false.
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.
