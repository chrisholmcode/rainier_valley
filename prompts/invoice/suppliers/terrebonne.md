Supplier: Terrebonne Truck Patch (North Bend, WA — small produce farm).
Document format: Hand-written invoice on a preprinted carbon-copy invoice book.
- Preprinted letterhead in the upper-left: "Terrebonne Truck Patch", 44539 SE 150th St North Bend WA, 98045, (425) 274-6152.
- Preprinted "INVOICE" label upper-right with a preprinted "No. <NNN>" invoice number (e.g., "No. 137"). A separate handwritten slip count may appear above (ignore that — use the printed "No." value).
- Preprinted column headers: SOLD TO | SHIP TO | CITY, STATE | ORDER NO. | SOLD BY | TERMS | F.O.B. | DATE | QUANTITY | DESCRIPTION | PRICE | AMOUNT.
- Most fields are blank or handwritten. Capture only what's actually filled in. Use null for blank handwritten fields.
- Quantity column => quantity (integer count). Single column — no separate ORDER/SHIP split; leave quantity_ordered null.
- Description => item_name_raw verbatim, including any repeated quantity (e.g., "100 Heads of green leaf", "50 bunch Radish Red").
- Price => unit_cost (per piece — per head, per bunch, etc.). Amount => line_total.
- Unit: heads / bunches / pieces — set unit = "ea". The handwritten description names the form (Heads / bunch / lb / etc.).
- approx_weight: count-only inventory with no weight unit in the description. Leave approx_weight null — do NOT guess piece weights.
- Category: all items are produce (this is a small produce farm). Set category = "produce" unless an item is clearly non-produce.
- delivery_date: Use the **Date** field in the upper-right (handwritten, often `M-D-YY` or `M/D/YY`). Convert to YYYY-MM-DD assuming 20YY for the year (e.g., `6-30-25` → `2025-06-30`).
- invoice_or_order_number: Use the printed **No.** value from the upper-right of the letterhead (e.g., "137"). If a handwritten "Order No." is also filled in, prefer the printed No.
- destination_org: Use the **Sold To** value (commonly "RVFB" or "Rainier Valley Food Bank").
- is_donation = false. These are real purchases with prices and a real amount due.
- Totals: this invoice book has no explicit subtotal/tax — only a final handwritten amount at the bottom of the Amount column. Use that as grand_total. Set subtotal = grand_total, tax = null.
- No fuel surcharge / energy charge / delivery fee — leave fees[] empty unless a real charge is visible.
- Ignore the large "Thank You!" watermark across the slip.
- If the photo shows multiple stacked slips, extract only the foreground (top-most) slip and note overlap in source_warnings.
