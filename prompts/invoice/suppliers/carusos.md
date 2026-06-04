Supplier: Caruso's Produce (Canby, OR).
Document format: Printed invoice with columns ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT.
- Use SHIPPED quantity (not ORDERED) for inventory count.
- ITEM CODE => item_code_raw
- DESCRIPTION => item_name_raw (keep exact, e.g., "BEAN GREEN 28#")
- Normalize: "BEAN GREEN 28#" => "Green Beans", "BROCCOLI CROWN 20#" => "Broccoli Crowns"
- delivery_date: Use the **SHIP DATE** field in the upper-right header block (NOT the "DATE" / invoice date field). SHIP DATE is when the goods physically ship and is the correct delivery date for the food bank.
- Filter out: Fuel surcharge, delivery fees (put in fees[] array)
- Ignore handwritten time notations at top of page.
