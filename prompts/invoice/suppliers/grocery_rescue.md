Supplier: Grocery Rescue. Food Lifeline brokers grocery-store rescue pickups (QFC / Safeway / Homegrown) to the food bank — this bucket is for those slips only. Distinct from `food_lifeline` (which is now reserved for printed Food Lifeline **Agency Order** manifests).

- "FOOD LIFELINE" logo upper-left. Form fields: Donor | Address | Agency | Date. Then a 3-column table: Product/Description | Pick Up Temp (F) | Drop Off Temp (F) | Pounds (lb).
- This is a hand-filled grocery rescue donation form. Goods come FROM a grocery store, Food Lifeline brokers the pickup, the food bank receives them.
- document_type = "manifest". supplier = "grocery_rescue". is_donation = true.
  - ⚠️ **`supplier` is ALWAYS `"grocery_rescue"` for this form — NEVER `"food_lifeline"`.** The "FOOD LIFELINE" logo printed on the slip is the broker's branding, not the supplier value. Do not let the on-slip logo drive the `supplier` field. `food_lifeline` is a separate bucket reserved only for printed Food Lifeline Agency Order manifests, which this handwritten rescue form is not.
- **donor_org**: Read the **Donor** field at the top. Grocery rescue only picks up from **5 fixed locations**. Map whatever is written on the slip to one of these exact short codes — do not invent new ones.

  | Slip variants (any of these) | donor_org (exact) |
  |---|---|
  | `QFC-MI`, `QFC MI`, `MI-QFC`, `QFC Mercer Island`, `QFC Mercer`, `QFC-Mercer` | `QFC-MI` |
  | `QFC-BWY`, `QFC-B`, `QFC-BW`, `QFC Brdwy`, `QFC Broadway`, `QFC-Broadway` | `QFC-BWY` |
  | `SWY-RB`, `Safeway-RB`, `Safeway RB`, `RB-Safeway`, `Safeway Rainier Beach`, `Safeway-Rainier` | `SWY-RB` |
  | `SWY-GEN`, `Safeway-G`, `Safeway Gen`, `Gen-Safeway`, `Safeway Genesee`, `Safeway-Genesee` | `SWY-GEN` |
  | `HG`, `Homegrown`, `HomeGrown`, `Home Grown` | `HG` |

  If the Donor field is illegible or doesn't clearly match one of these five, set donor_org=null, lower slip confidence, and add a source_warning `"donor_org unrecognized: <verbatim value>"` so a reviewer can correct it. Never emit a donor_org outside the five values above.

  - **Donor and Date fields are sometimes swapped by staff.** Identify each value by its shape: a date pattern (M/D, M/D/YY, MM-DD-YY) goes to delivery_date; a store-suffix code (letters with a hyphen-suffix, no slashes) goes to donor_org. Use whichever field actually contains each value.
- delivery_date and invoice_date: The handwritten Date (see swap note above). Convert to YYYY-MM-DD. If only two digits are given for the year, assume 20YY. If no year is written at all (bare M/D like "7/1"), use the year from `Today's date` in the user message — these forms are filled the day of pickup, so year-boundary edge cases (e.g., a bare "12/28" seen in early January) should use the previous year. Populate BOTH `invoice_date` and `delivery_date` with the resolved value.
  - **Format is always M/D (month first, then day) — never D/M.** If the two numeric parts could be read either way (e.g., "7/8" — both ≤ 12), always treat the **first** as the month and the **second** as the day. Do NOT swap. Example: "7/7" → `2026-07-07`, NOT `2026-08-07`.
  - **Single-digit month legibility warning:** if the handwritten month digit is ambiguous (could be "7" or "8", ink smudged, only partially legible), do NOT silently pick one — emit your best reading, set confidence ≤ 0.7, and add a `source_warning`: `"delivery_date month digit unclear: read as <your reading> but may be different — please verify against slip"`.
  - Sanity check: if the extracted month is "08" but the filename or upload context (`Today's date`) suggests July, re-examine the source — you have likely transposed month and day. When in doubt, prefer the reading consistent with the upload date.
- destination_org: The Agency field if filled in with a legible organization name; otherwise default to "Rainier Valley Food Bank" (the receiving food bank is implicit on rescue forms). Only use a different value if the Agency field clearly names another organization.
- invoice_or_order_number: synthesize a shipment ID as `<donor_org>-<delivery_date>` (e.g. `QFC-MI-2026-07-13`, `SWY-GEN-2026-07-01`). This is the unique key for one grocery rescue pickup — only one shipment per store per day, so the store+date combination is guaranteed unique. If either donor_org or delivery_date is unresolved (null), leave invoice_or_order_number null and let a reviewer fill it in.
- **Pick Up Temp (F) and Drop Off Temp (F) columns are NOT USED — ignore them entirely.** The RVFB team never fills these consistently and does not track them downstream. Do not extract, do not warn, do not derive anything from these two columns. Only the Product/Description column (row label) and the Pounds (lb) column matter.
- **Hatched cells: distinguish between whole-row and temp-column hatching.**
  - The two **temperature columns** are pre-printed hatched for shelf-stable rows (Canned/Dry Goods, Nonfood, sometimes Bakery / Coffee Kiosk) because temperature doesn't apply to non-perishables. This is **NOT** a signal that the category is unaccepted — it's the form design. If the Pounds cell for that row has a value, extract it normally. If it's blank, treat it as a blank skeleton row (per the rules below). **Never mark a row "not accepted" because its Temp columns are hatched.**
  - Only when the **entire row label / Product name** is struck through, hatched over, or "X-ed" out end-to-end should you treat it as "category not accepted this pickup." This is much rarer.
- Predefined category rows (visible on every form):
  | Row label | category | Notes |
  |---|---|---|
  | Bakery | shelf_stable | Bread, pastries. Temp columns often hatched (normal). |
  | Canned/Dry Goods | shelf_stable | Temp columns ALWAYS hatched (normal for shelf-stable — category IS accepted). |
  | Coffee Kiosk | shelf_stable | Temp columns often hatched. Rarely delivered. |
  | Dairy/Juice/Alt. Dairy | dairy | |
  | Frozen Foods | frozen | |
  | Meat | meat_protein | |
  | Nonfood | non_food | Temp columns ALWAYS hatched (normal — category IS accepted when Pounds is filled). |
  | Non-Meat Protein (eggs, tofu) | dairy | Eggs/tofu — best fit is dairy |
  | Prepared/Perishable | produce | |
  | Produce | produce | |
- **Always emit one line item per predefined row — all 10, every time, in the order above.** This gives the reviewer a pre-populated skeleton to correct if the extractor missed a value, so they never have to manually add a row. Never skip a row.
- Common fields for every row:
  - item_name_raw = the row label verbatim (e.g., "Bakery", "Dairy/Juice/Alt. Dairy").
  - item_name_normalized = a clean version (e.g., "Bakery", "Dairy / Juice / Alt. Dairy").
  - unit = "lb".
  - category = per the table above.
- **Rows with a non-empty Pounds cell:**
  > ⚠️ **All three of `approx_weight`, `quantity`, and `quantity_raw` are REQUIRED and must be non-null on any row where any numeral is legible in the Pounds cell.** These are the three most-corrected fields in production. If you can read even one number, extract it — never leave them blank. `quantity` must always equal `approx_weight` on rescue forms.
  - approx_weight = the final/accepted pounds, parsed per the **Running-tally rule** below. **NEVER leave `approx_weight` blank when any numeral is legible.** If the number is hard to read, extract your best guess, lower `confidence` to ≤ 0.6, and add a `source_warning`. Only set `approx_weight = null` when the cell contains **absolutely no writing**.
  - quantity = **REQUIRED — always set equal to `approx_weight` whenever `approx_weight` is non-null.** The Pounds cell is both the weight and the billed quantity. Example: Pounds cell reads "17" → `approx_weight = 17`, `quantity = 17`.
  - quantity_raw = **REQUIRED — never leave blank for a non-empty cell.** Copy every visible digit/number from the Pounds cell exactly as written, preserving all numbers including crossed-out ones and earlier tally values (e.g., a cell showing "70 79" → `quantity_raw = "70 79"`; a clean single value "24" → `quantity_raw = "24"`). Even a lone clean number must be emitted here.
  - notes = brief description (e.g., "running tally 151→123→108→40, taking 40 as last value" or "two weighings summed: 144+27=171").
  - confidence = lower (0.6–0.8) when the cell has crossed-out / overwritten numbers, higher (0.9+) when it's a single clean number.
- **Rows with an empty Pounds cell (blank, no writing):**
  - approx_weight = null, quantity = null, quantity_raw = null.
  - notes = "no value on form".
  - confidence = 0.95 (blank is unambiguous; do not drag the slip into review queue for a legitimately empty row).
- **Rows with hatched/struck-through row label (category not accepted this pickup):**
  - approx_weight = null, quantity = null, quantity_raw = null.
  - notes = "row hatched out — category not accepted this pickup".
  - confidence = 0.95.

### Running-tally rule for the Pounds column

> **Digit-boundary caution — read BEFORE applying any pattern below.**
> Each tally entry is a single integer. Before classifying the pattern, explicitly list every discrete number you see in the cell — separated by spaces, line breaks, or crossouts. Treat a contiguous run of digits (no space or line break between them) as ONE number. **Do NOT split a multi-digit number such as "117" into "1" and "17", and do NOT merge two separate numbers such as "1" and "17" into "117".** If you're unsure whether a gap between digits is a word-space or handwriting variation, report both interpretations in `quantity_raw`, lower confidence to 0.6, and pick the reading that produces the most plausible weight (typically the larger value for grocery rescue quantities).

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

### Future: printed grocery-rescue invoices

Some grocery-rescue slips will eventually arrive as **printed invoices** rather than the handwritten Food Lifeline form (with per-line SKUs, unit prices, weights — similar shape to Caruso's or Charlie's). When that happens: still `supplier = "grocery_rescue"`, `is_donation = true`, keep the same `donor_org` set (the retail store), and use the printed line-item extraction rules from the general invoice guidance. The synthesized `invoice_or_order_number = <donor_org>-<delivery_date>` convention still applies unless the printed invoice carries its own invoice number, in which case use that.
