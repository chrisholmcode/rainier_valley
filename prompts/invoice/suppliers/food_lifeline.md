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
  - The printed Ship Date is in **MM/DD/YYYY** format. Read each of the three parts (month, day, year) as separate digit groups and re-emit as YYYY-MM-DD. Do NOT swap month and day.
  - Read the month digits carefully: a printed "07" (July) is frequently misread as "08" (August). Verify the month glyph before committing — if the leading month digit is a single "7", the month is `07`, not `08`.
  - Every output segment must be zero-padded and valid: month `01`–`12`, day `01`–`31`. Never emit a malformed month like `0` or `8` — if your parse yields an invalid or single-digit month, re-read the Ship Date rather than guessing.
- invoice_or_order_number: Use the **Agency Order No** value in the upper-right (e.g., "ACR-XXXXXX").
- destination_org: Use the **Sold To** name (typically "Rainier Valley Food Bank").
- Totals: subtotal = 0, tax = 0, grand_total = 0. Preserve the printed zeros.
- fees[] = [].
- Ignore handwritten storage allocations (e.g., "F-1", "C-3", "D-1") and receipt checkmarks.

## Not this supplier

- Handwritten Food Lifeline slip with Donor / Address / Agency / Date fields and a per-category Pounds column → `supplier = "grocery_rescue"` (separate prompt).
- "northwest HARVEST" (Auburn warehouse, "Warehouse Posted Shipment" header) → `supplier = "nw_harvest"`.
