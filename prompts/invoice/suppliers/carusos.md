Supplier: Caruso's Produce (Canby, OR).
Document format: Printed invoice with columns ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT.
- ORDERED column => quantity_ordered. SHIPPED column => quantity (authoritative inventory count). Capture both — when SHIPPED < ORDERED the supplier shorted the order and we need that visible.
- **approx_weight is REQUIRED whenever the pack notation contains a weight unit (`#` or `OZ` or `LB`).** Caruso's invoices do not have an APPROX.WT. column, but the pack notation in the DESCRIPTION embeds the weight per case — you must compute total line pounds from `quantity × pack_weight_per_case` and put that number in `approx_weight`. Do NOT leave it null just because no column is labeled APPROX.WT. Rules:
  - Pack `N#` (e.g., `20#`, `25#`, `28#`) => N lb per case. approx_weight = quantity × N.
  - Pack `N/M#` (e.g., `12/1#`, `24/1#`) => N × M lb per case. approx_weight = quantity × N × M.
  - Pack `N/M OZ` (e.g., `12/6 OZ`, `24/8 OZ`) => (N × M) / 16 lb per case. approx_weight = quantity × N × M / 16.
  - Pack is count-only with no weight unit (e.g., `12 CT`, `56 CT`, `48 CT`) => approx_weight = null. Do NOT guess piece weights.
  - Worked example: 10 cases of `BROCCOLI CROWN 20#` → approx_weight = 10 × 20 = 200.
  - Worked example: 20 cases of `BERRIES RASPBERRY PACKER 12/6 OZ` → approx_weight = 20 × 12 × 6 / 16 = 90.
- ITEM CODE => item_code_raw
- DESCRIPTION => item_name_raw (keep exact, e.g., "BEAN GREEN 28#")
- Normalize: "BEAN GREEN 28#" => "Green Beans", "BROCCOLI CROWN 20#" => "Broccoli Crowns"
- delivery_date: Use the **SHIP DATE** field in the upper-right header block (NOT the "DATE" / invoice date field). SHIP DATE is when the goods physically ship and is the correct delivery date for the food bank.
- Filter out: Fuel surcharge, delivery fees (put in fees[] array)
- Ignore handwritten time notations at top of page.
