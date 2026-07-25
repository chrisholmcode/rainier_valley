Supplier: Food Lifeline (AGENCY ORDER — printed manifest). NOTE: hand-filled grocery rescue slips are now a separate supplier (`grocery_rescue`) — if this document is the handwritten Donor / Address / Agency / Date form with a Pounds column, set `supplier = "grocery_rescue"` and follow that supplier's prompt instead.

## Subtype: AGENCY ORDER (printed manifest)

- "FOOD LIFELINE" logo upper-left, "AGENCY ORDER" header upper-right.
- Printed line items in columns. No money changes hands; all dollar totals are $0.
- document_type = "manifest". supplier = "food_lifeline". donor_org = null. is_donation = true.
- Columns: Item No. | Description | Unit | Quantity | Cubic Feet | Unit Fee | Total Fee | Gross Weight.
- Item No. (e.g., "28AAA80-TEFA", "28AA830-CITY") => item_code_raw verbatim, including the trailing source suffix.
  - Suffix `-TEFA` => TEFAP federal commodity (USDA). Note in line `notes`: "funding: TEFAP".
  - Suffix `-CITY` => City Fund donation. Note in line `notes`: "funding: CITY".
  - Other suffixes (e.g., `-EFAP`, `-CSFP`) => capture the suffix into notes verbatim.
- Description => item_name_raw verbatim. When normalizing for item_name_normalized, strip the leading source-program prefix and the trailing `FB` markers — "TEFAP FB Chicken Drumsticks (1115795) FB" => "Chicken Drumsticks". The number in parentheses is a USDA item code; keep it out of the normalized name.
- Quantity column => quantity. Unit column => unit (lowercase "Case" => "case"). Gross Weight => approx_weight (TOTAL pounds for the line, not per-case).
- Category: derive from item name. Produce (Bok Choy, Zucchini, Pears, Grapefruit) => "produce". Meat (Chicken Drumsticks) => "meat_protein". Pantry / canned (Peanut Butter, Pinto Beans, Rice) => "shelf_stable".
- delivery_date and invoice_date: Food Lifeline AGENCY ORDER manifests carry a single **Ship Date** field in the upper-left. Populate BOTH `invoice_date` and `delivery_date` with that value (YYYY-MM-DD).
  - Transcribe the Ship Date digit-for-digit; do NOT infer or "correct" the month from context. On these manifests the month is printed compactly and is easily misread — read the printed month glyph directly rather than assuming a nearby value.
  - The month MUST be a valid two-digit value 01–12, zero-padded (e.g., July => "07"). Never emit a single-digit or truncated month such as "0" or "8"; if the month reads as a single digit N, output it as "0N". If the month is not clearly legible, do not guess an adjacent value — re-read the glyph before committing.
  - Common failure to avoid: reading July ("07") as August ("08"). Verify the second month digit against the printed date, not against the surrounding line items.
- invoice_or_order_number: Use the **Agency Order No** value in the upper-right (e.g., "ACR-XXXXXX").
- destination_org: Use the **Sold To** name (typically "Rainier Valley Food Bank").
- Totals: subtotal = 0, tax = 0, grand_total = 0. Preserve the printed zeros.
- fees[] = [].
- Ignore handwritten storage allocations (e.g., "F-1", "C-3", "D-1") and receipt checkmarks.

## Not this supplier

- Handwritten Food Lifeline slip with Donor / Address / Agency / Date fields and a per-category Pounds column → `supplier = "grocery_rescue"` (separate prompt).
- "northwest HARVEST" (Auburn warehouse, "Warehouse Posted Shipment" header) → `supplier = "nw_harvest"`.
