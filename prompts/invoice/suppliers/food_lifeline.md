Supplier: Food Lifeline. **Two distinct document subtypes — pick the matching one before extracting.**

## Subtype A — AGENCY ORDER (printed manifest)

- "FOOD LIFELINE" logo upper-left, "AGENCY ORDER" header upper-right.
- Printed line items in columns. No money changes hands; all dollar totals are $0.
- document_type = "manifest". donor_org = null. is_donation = true.
- Columns: Item No. | Description | Unit | Quantity | Cubic Feet | Unit Fee | Total Fee | Gross Weight.
- Item No. (e.g., "28AAA80-TEFA", "28AA830-CITY") => item_code_raw verbatim, including the trailing source suffix.
  - Suffix `-TEFA` => TEFAP federal commodity (USDA). Note in line `notes`: "funding: TEFAP".
  - Suffix `-CITY` => City Fund donation. Note in line `notes`: "funding: CITY".
  - Other suffixes (e.g., `-EFAP`, `-CSFP`) => capture the suffix into notes verbatim.
- Description => item_name_raw verbatim. When normalizing for item_name_normalized, strip the leading source-program prefix and the trailing `FB` markers — "TEFAP FB Chicken Drumsticks (1115795) FB" => "Chicken Drumsticks". The number in parentheses is a USDA item code; keep it out of the normalized name.
- Quantity column => quantity. Unit column => unit (lowercase "Case" => "case"). Gross Weight => approx_weight (TOTAL pounds for the line, not per-case).
- Category: derive from item name. Produce (Bok Choy, Zucchini, Pears, Grapefruit) => "produce". Meat (Chicken Drumsticks) => "meat_protein". Pantry / canned (Peanut Butter, Pinto Beans, Rice) => "shelf_stable".
- delivery_date: Use the **Ship Date** field in the upper-left.
- invoice_or_order_number: Use the **Agency Order No** value in the upper-right (e.g., "ACR-XXXXXX").
- destination_org: Use the **Sold To** name (typically "Rainier Valley Food Bank").
- Totals: subtotal = 0, tax = 0, grand_total = 0. Preserve the printed zeros.
- fees[] = [].
- Ignore handwritten storage allocations (e.g., "F-1", "C-3", "D-1") and receipt checkmarks.

## Subtype B — GROCERY RESCUE PICKUP (handwritten form)

- "FOOD LIFELINE" logo upper-left. Form fields: Donor | Address | Agency | Date. Then a 3-column table: Product/Description | Pick Up Temp (F) | Drop Off Temp (F) | Pounds (lb).
- This is a hand-filled grocery rescue donation form. Goods come FROM a grocery store, Food Lifeline brokers the pickup, the food bank receives them.
- document_type = "manifest". supplier = "food_lifeline". is_donation = true.
- **donor_org**: Read the **Donor** field at the top. Typical format is `<Store> - <Neighborhood>` (e.g., `QFC-MI` for QFC Mercer Island, `Safeway-RB` for Safeway Rainier Beach). Capture verbatim.
  - **Donor and Date fields are sometimes swapped by staff.** Identify each value by its shape: a date pattern (M/D, M/D/YY, MM-DD-YY) goes to delivery_date; a store-suffix code (letters with a hyphen-suffix, no slashes) goes to donor_org. Use whichever field actually contains each value.
- delivery_date: The handwritten Date (see swap note above). Convert to YYYY-MM-DD; assume 20YY when only two digits are given.
- destination_org: The Agency field if filled in; otherwise null. (Often blank — the destination is implicit.)
- invoice_or_order_number: null (these forms have no number).
- Predefined category rows (visible on every form):
  | Row label | category | Notes |
  |---|---|---|
  | Bakery | shelf_stable | Bread, pastries |
  | Canned/Dry Goods | shelf_stable | |
  | Coffee Kiosk | shelf_stable | Often hatched out (not accepted) — skip if hatched |
  | Dairy/Juice/Alt. Dairy | dairy | |
  | Frozen Foods | frozen | |
  | Meat | meat_protein | |
  | Nonfood | non_food | Often hatched out (not accepted) — skip if hatched |
  | Non-Meat Protein (eggs, tofu) | dairy | Eggs/tofu — best fit is dairy |
  | Prepared/Perishable | produce | |
  | Produce | produce | |
- For each row that has a non-empty Pounds value, emit ONE line item:
  - item_name_raw = the row label verbatim (e.g., "Bakery", "Dairy/Juice/Alt. Dairy").
  - item_name_normalized = a clean version (e.g., "Bakery", "Dairy / Juice / Alt. Dairy").
  - quantity = null. quantity_raw = the verbatim contents of the Pounds cell (all visible numbers as one string, e.g., "151 123 108 40" — preserve so the human can audit).
  - unit = "lb".
  - approx_weight = the final/accepted pounds for that row, parsed per the **Running-tally rule** below.
  - category = per the table above.
  - notes = brief description of what you saw (e.g., "running tally 151→123→108→40, taking 40 as last value" or "two weighings summed: 144+27=171").
  - confidence = lower (0.6–0.8) when the cell has crossed-out / overwritten numbers, higher (0.9+) when it's a single clean number.
- Rows with no value (or with hatched/struck-through row labels indicating the category isn't accepted) => skip entirely.

### Running-tally rule for the Pounds column

The Pounds cell is often hand-filled while counting; you'll see one of these patterns:

1. **Single clean number** (e.g., "183") => approx_weight = 183.
2. **Multiple numbers, last one circled or boxed** => the circled/boxed number is the final count. approx_weight = circled value.
3. **Earlier numbers crossed out, final number clean** (e.g., "32~~13~~" or "13" crossed out, "32" not) => approx_weight = the non-crossed final number.
4. **Stacked weighings without crossouts** (e.g., "144" on top, "27" below) => the staff weighed separate pallets/bins; approx_weight = sum (144 + 27 = 171). Note "summed across weighings" in line notes.
5. **Sequence with descending or non-monotonic numbers and no clear circle** (e.g., "151 123 108 40") => these are typically running adjustments while counting; approx_weight = the LAST number written (40 in this case). Note "running tally; taking last value" in line notes and lower confidence to 0.6.

If you cannot resolve which pattern applies, set approx_weight to the largest clean number visible, set confidence ≤ 0.6, and add a source_warning explaining the ambiguity.

### Totals and fees on grocery rescue forms

- subtotal = null, tax = null, grand_total = null. The "Total:" box in the lower-right is usually blank — leave totals null unless a number is clearly written.
- fees[] = []. There are no fees on rescue forms.

## Common to both subtypes

- supplier = "food_lifeline".
- NOTE: "northwest HARVEST" (Auburn warehouse, "Warehouse Posted Shipment" header) is a separate vendor — if the document is from Northwest Harvest, set supplier="nw_harvest" instead.
