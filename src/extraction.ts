import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { env } from "./config.js";
import type { ExtractionResult, EodExtractionResult, Supplier } from "./types.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const extractionSchema = z.object({
  document_type: z.enum(["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"]),
  supplier: z.enum(["carusos", "charlies", "nw_harvest", "pacific", "unknown"]),
  delivery_date: z.string().nullable(),
  invoice_or_order_number: z.string().nullable(),
  destination_org: z.string().nullable(),
  line_items: z.array(
    z.object({
      item_code_raw: z.string().nullable(),
      item_name_raw: z.string().nullable(),
      item_name_normalized: z.string().nullable(),
      quantity: z.number().nullable(),
      quantity_raw: z.string().nullable(),
      unit: z.enum(["case", "ct", "lb", "oz", "ea", "bushel", "other"]).nullable(),
      pack_size_raw: z.string().nullable(),
      category: z.enum(["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"]),
      unit_cost: z.number().nullable(),
      line_total: z.number().nullable(),
      is_fee: z.boolean(),
      notes: z.string().nullable(),
      confidence: z.number().min(0).max(1)
    })
  ),
  fees: z.array(
    z.object({
      description: z.string(),
      amount: z.number().nullable()
    })
  ),
  totals: z.object({
    subtotal: z.number().nullable(),
    tax: z.number().nullable(),
    grand_total: z.number().nullable()
  }),
  source_warnings: z.array(z.string())
});

const SYSTEM_PROMPT = `You extract structured receiving data from food-bank delivery documents and dock photos.

Non-negotiable rules:
1) Never hallucinate. If unknown, return null.
2) Preserve source text exactly in *_raw fields.
3) Normalize names in *_normalized fields using obvious standardization only.
4) Output valid JSON only (no markdown fences, no prose).
5) Quantities must be numeric when possible; otherwise keep raw text and set quantity=null.
6) Include confidence scores from 0.00 to 1.00 for each line item.
7) Distinguish line-item products from fees/charges (fuel surcharge, energy charge, delivery fees go to fees[]).
8) If multiple pages/images are provided for one delivery, merge into one response and deduplicate identical lines.
9) If a field is not present on the document, set it to null.
10) Use SHIPPED quantity (not ORDERED) - this is what was actually received.

Pack size notation guide:
- # suffix means pounds (28# = 28 lb case)
- CT = count
- LB = pounds
- OZ = ounces
- BUSHEL = bushel
- 12/6 OZ = 12 units of 6 oz each
- 20/1LB = 20 units of 1 lb each`;

const SUPPLIER_PROMPTS: Record<Supplier, string> = {
  carusos: `Supplier: Caruso's Produce (Canby, OR).
Document format: Printed invoice with columns ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT.
- Use SHIPPED quantity (not ORDERED) for inventory count.
- ITEM CODE => item_code_raw
- DESCRIPTION => item_name_raw (keep exact, e.g., "BEAN GREEN 28#")
- Normalize: "BEAN GREEN 28#" => "Green Beans", "BROCCOLI CROWN 20#" => "Broccoli Crowns"
- delivery_date: Use the **SHIP DATE** field in the upper-right header block (NOT the "DATE" / invoice date field). SHIP DATE is when the goods physically ship and is the correct delivery date for the food bank.
- Filter out: Fuel surcharge, delivery fees (put in fees[] array)
- Ignore handwritten time notations at top of page.`,

  charlies: `Supplier: Charlie's Produce (Seattle, WA).
Document format: Customer invoice with columns ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION.
- Use SHIP quantity for inventory count.
- ITEM# => item_code_raw
- PACK SIZE => pack_size_raw (e.g., "1 40CT", "1 25LB")
- Descriptions use commas: "AVOCADO,HASS GREEN" not spaces.
- Origin codes may appear: MX (Mexico), UCA, etc. - put in notes.
- delivery_date: Use the **INVOICE DATE** field (or "INVOICED") in the upper-right header row, typically next to ACCOUNT# and INVOICE#. Format is usually MM/DD/YY — convert to YYYY-MM-DD. Do NOT leave delivery_date null when this field is visible.
- invoice_or_order_number: Use the **INVOICE#** column value in the upper-right header row (between ACCOUNT# and INVOICE DATE). Typically a 7-digit number like "7172545". Do NOT leave null when visible.
- Filter out: Energy charge (put in fees[] array)
- CHECK marks (/) in SHIP column indicate verification.`,

  nw_harvest: `Supplier: Northwest Harvest (Auburn warehouse).
Document format: Warehouse Posted Shipment with columns Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight.
- Quantity column is authoritative (case count).
- Weight column is TOTAL weight, not per-unit weight.
- Class Code: AMBIENT or CHILL - maps to storage area.
- Unit of Measure Code describes pack size (e.g., 20/1LB = 20 bags of 1 lb each).
- May include non-food items (facemasks, etc.) - still track them as non_food category.
- Filter out: Grand Totals row.
- If image shows only a pallet label (no line items), add warning to source_warnings.`,

  pacific: `Supplier: Pacific Food Distributors.
Document format: Bill of Lading / Sales Order with fields like Qty Shipped, Size, Pack, Description.
- May be routed through intermediary (e.g., The Weigel Company LLC).
- Document may have partial visibility or overlapping papers.
- Extract what's visible; mark low confidence for unclear items.`,

  unknown: `AUTO-DETECT SUPPLIER from the document. Look for these identifying features:

**Caruso's Produce** (set supplier: "carusos")
- Logo says "CARUSO" or "Caruso Produce"
- Location: Canby, OR or 2100 SE 4th Avenue
- Columns: ORDERED | SHIPPED | ITEM CODE | DESCRIPTION | ORIGIN | UNIT PRICE | EXTENDED AMOUNT
- Use SHIPPED quantity. Filter out fuel surcharge.
- delivery_date: Use the **SHIP DATE** field in the upper-right header (NOT the "DATE" / invoice date field).

**Charlie's Produce** (set supplier: "charlies")
- Logo says "Charlie's Produce"
- Location: Seattle, WA or PO Box 24606 or 4123 2nd Ave S
- Columns: ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION
- Descriptions use commas (e.g., "AVOCADO,HASS GREEN"). Use SHIP quantity. Filter out energy charge.
- delivery_date: Use the **INVOICE DATE** field in the upper-right header (next to ACCOUNT# / INVOICE#). Convert MM/DD/YY to YYYY-MM-DD.
- invoice_or_order_number: Use the **INVOICE#** value in the upper-right header (between ACCOUNT# and INVOICE DATE), typically a 7-digit number.

**Northwest Harvest / Food Lifeline** (set supplier: "nw_harvest")
- Header says "Northwest Harvest" or "Warehouse Posted Shipment" or "Food Lifeline"
- Location: Auburn warehouse
- Columns: Item No. | Quantity | Description | Unit of Measure Code | Class Code | Weight
- Weight column is TOTAL weight. Class Code = storage (AMBIENT/CHILL). Filter out Grand Totals row.
- If only a pallet label (no line items), add warning to source_warnings.

**Pacific Food Distributors** (set supplier: "pacific")
- Header says "Pacific Food Distributors"
- Bill of Lading format. May mention intermediary like "The Weigel Company LLC".

If you cannot identify the supplier, set supplier to "unknown" and extract conservatively.`
};

function sanitizeJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```") && trimmed.startsWith("{")) {
    return trimmed;
  }

  const withoutFence = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  return withoutFence;
}

export function guessSupplierFromFilename(filename: string): Supplier {
  const f = filename.toLowerCase();
  if (f.includes("caruso")) return "carusos";
  if (f.includes("charlie")) return "charlies";
  if (f.includes("harvest") || f.includes("nw") || f.includes("food lifeline")) return "nw_harvest";
  if (f.includes("pacific") || f.includes("pfd")) return "pacific";
  return "unknown";
}

function mimeToMediaType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "image/png";
  if (normalized.includes("gif")) return "image/gif";
  if (normalized.includes("webp")) return "image/webp";
  return "image/jpeg";
}

export async function extractFromImage(params: {
  imageBytes: Buffer;
  mimeType: string;
  filename: string;
  supplierHint: Supplier;
}): Promise<ExtractionResult> {
  const { imageBytes, mimeType, filename, supplierHint } = params;

  const userPrompt = `${SUPPLIER_PROMPTS[supplierHint]}

Filename: ${filename}

Analyze the attached image and extract all delivery line items. Return ONLY a valid JSON object matching this schema:
{
  "document_type": "invoice" | "manifest" | "warehouse_posted_shipment" | "dock_photo" | "unknown",
  "supplier": "carusos" | "charlies" | "nw_harvest" | "pacific" | "unknown",
  "delivery_date": "YYYY-MM-DD" | null,
  "invoice_or_order_number": string | null,
  "destination_org": string | null,
  "line_items": [
    {
      "item_code_raw": string | null,
      "item_name_raw": string | null,
      "item_name_normalized": string | null,
      "quantity": number | null,
      "quantity_raw": string | null,
      "unit": "case" | "ct" | "lb" | "oz" | "ea" | "bushel" | "other" | null,
      "pack_size_raw": string | null,
      "category": "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown",
      "unit_cost": number | null,
      "line_total": number | null,
      "is_fee": false,
      "notes": string | null,
      "confidence": 0.0-1.0
    }
  ],
  "fees": [{ "description": string, "amount": number | null }],
  "totals": { "subtotal": number | null, "tax": number | null, "grand_total": number | null },
  "source_warnings": string[]
}`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeToMediaType(mimeType),
              data: imageBytes.toString("base64")
            }
          },
          {
            type: "text",
            text: userPrompt
          }
        ]
      }
    ]
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response returned by Claude.");
  }

  const parsed = extractionSchema.safeParse(JSON.parse(sanitizeJson(textBlock.text)));
  if (!parsed.success) {
    throw new Error(`Extraction schema validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}

// ── EOD Inventory extraction ──────────────────────────────────────────────────

const eodLineItemSchema = z.object({
  item_name_raw: z.string().nullable(),
  item_name_normalized: z.string().nullable(),
  quantity: z.number().nullable(),
  quantity_raw: z.string().nullable(),
  unit: z.enum(["case", "bag", "pallet", "lb", "oz", "ct", "ea", "other"]).nullable(),
  category: z.enum(["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"]),
  notes: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  program_type: z.enum(["home_delivery", "in_person_shopping", "pre_made_bags", "unknown"]).nullable().optional().default(null)
});

const eodExtractionSchema = z.object({
  date: z.string().nullable(),
  line_items: z.array(eodLineItemSchema),
  source_warnings: z.array(z.string())
});

const EOD_SYSTEM_PROMPT = `You extract end-of-day inventory counts from free-text or transcribed speech from food bank staff.

Rules:
1) Extract every item mentioned with its quantity and unit.
2) Preserve the original phrasing in item_name_raw. Normalize to a clean title-case name in item_name_normalized (e.g. "bags of potatoes" → "Potatoes").
3) Infer unit from context: "bags" → "bag", "pallets" → "pallet", "cases" → "case". Default to "ea" if unclear.
4) Assign category based on item type (produce, meat_protein, dairy, shelf_stable, frozen, non_food, unknown).
5) If the speaker mentions a date, extract as YYYY-MM-DD. Otherwise set date to null.
6) Set confidence 0.0-1.0 based on how clearly the item and quantity were stated.
7) Add source_warnings for anything ambiguous (unclear quantity, unknown item, etc.).
8) Output valid JSON only — no markdown fences, no prose.`;

export async function extractFromText(text: string): Promise<EodExtractionResult> {
  const userPrompt = `Extract all inventory items from the following end-of-day count. Return ONLY valid JSON matching this schema:
{
  "date": "YYYY-MM-DD" | null,
  "line_items": [
    {
      "item_name_raw": string | null,
      "item_name_normalized": string | null,
      "quantity": number | null,
      "quantity_raw": string | null,
      "unit": "case" | "bag" | "pallet" | "lb" | "oz" | "ct" | "ea" | "other" | null,
      "category": "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown",
      "notes": string | null,
      "confidence": 0.0-1.0
    }
  ],
  "source_warnings": string[]
}

Text:
${text}`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: EOD_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }]
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response returned by Claude.");
  }

  const parsed = eodExtractionSchema.safeParse(JSON.parse(sanitizeJson(textBlock.text)));
  if (!parsed.success) {
    throw new Error(`EOD extraction schema validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}

// ── Image classification (whiteboard vs invoice) ──────────────────────────────

export async function classifyImage(params: {
  imageBytes: Buffer;
  mimeType: string;
}): Promise<"whiteboard" | "invoice"> {
  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 16,
    system: "You classify photos for a food bank inventory bot. Reply with EXACTLY one word.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeToMediaType(params.mimeType),
              data: params.imageBytes.toString("base64")
            }
          },
          {
            type: "text",
            text:
              "Is this a handwritten whiteboard (or paper) listing items with tally marks for outbound tracking, " +
              "or a printed delivery invoice / manifest / shipment document? " +
              "Reply with exactly one word: 'whiteboard' or 'invoice'."
          }
        ]
      }
    ]
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") return "invoice";
  return textBlock.text.trim().toLowerCase().includes("whiteboard") ? "whiteboard" : "invoice";
}

// ── Whiteboard outbound extraction ────────────────────────────────────────────

const WHITEBOARD_SYSTEM_PROMPT = `You extract outbound case counts from photos of handwritten whiteboards or paper lists at a food bank.

There are three outbound PROGRAMS and TWO possible layouts:
- Home Delivery (HD) and Pre Made Bags (PMB) share ONE whiteboard.
- In Person Shopping (IPS) is on a SEPARATE paper/whiteboard with a different layout.

Program tagging — set program_type per line item:
- "home_delivery" — header reads "Home Delivery" (also HD); items in the main area of the shared whiteboard, including any sub-sections like "Fruit" or "Protein".
- "pre_made_bags" — items written INSIDE a visibly boxed-off region on the shared whiteboard labeled "Premade-Bag", "Pre Made Bags", "Premade Bags", or "PMB". Only items inside that box are PMB.
- "in_person_shopping" — header reads "In Person Shopping" (also IPS); EVERY line on that page is in_person_shopping.
- "unknown" — use only when the layout is recognizable but a specific row can't be confidently assigned. Add a source_warnings entry too.

Layout A — Home Delivery / Pre Made Bags shared whiteboard:
- Header in the main area: "Home Delivery — <date>".
- Numbered or bulleted list, each line: <item name> — <initial>[cs] [tally marks]
- Items may be grouped under sub-section labels (e.g. "Fruit", "Protein") — these are still Home Delivery.
- A separately-drawn box somewhere on the same whiteboard, labeled with a PMB variant, contains the Pre Made Bags items. Items inside that box use the same <item> — <initial>[cs] [tallies] format.

Layout B — In Person Shopping paper:
- Header: "<date> In Person Shopping" (date may appear before or after the title).
- Each line: <item name> <integer>
- NO tally marks. NO "cs" suffix. Just a single integer that IS the final quantity.
- Two columns are common. Process both columns.

CRITICAL — Reading the initial number:
- The initial is a NUMBER (1, 2, 3, ... 12, etc.) optionally followed by "cs" or "cs." which is the abbreviation for "cases".
- "cs" is a UNIT SUFFIX, NOT digits. Never read it as part of the number.
  - "4cs" → initial = 4 (NOT 43, NOT 45, NOT 4cs)
  - "12cs" → initial = 12 (NOT 12c5, NOT 125)
  - "8cs." → initial = 8
- If you can't tell whether a character is "c" or a digit, prefer reading it as "c" (the unit), since handwritten "cs" is the convention here.

CRITICAL — Counting tally marks (5-bar gate convention):

Definitions:
- A GATE = exactly 4 vertical strokes with 1 diagonal or horizontal slash crossing through them. A gate counts as 5.
- A LOOSE STROKE = a single vertical line with NO slash crossing it. A loose stroke counts as 1.
- A "stroke" by itself, without a visible crossing slash, is LOOSE — it is not part of a gate.

How to count, line by line:
1. First, scan the line and identify every visible DIAGONAL OR HORIZONTAL SLASH stroke. Each slash defines exactly one gate.
2. For every slash you see, that's 1 gate (= 5). The 4 verticals it crosses do NOT also count as 4 loose strokes — they belong to the gate.
3. Any remaining vertical strokes that are NOT crossed by a slash are loose strokes, each counting as 1.
4. tallies = (gates × 5) + (loose strokes × 1)

Defensive rule — when the photo is unclear:
- If you cannot CLEARLY see a slash crossing a group of verticals, do NOT assume a gate. Count those verticals as loose.
- Undercounting tallies is far better than overcounting. If you suspect a gate but aren't sure, count loose and lower confidence.
- If the stroke pattern is messy, ambiguous, or smudged: flag it in source_warnings and lower confidence to 0.5 or below.

Worked examples:
- "Apples — 4cs ||"
  → 0 slashes visible → 0 gates. 2 vertical strokes loose. tallies = 0×5 + 2 = 2. total = 4 + 2 = 6.
- "Cabbage — 7cs ||||/ ||||/ ||||/"
  → 3 slashes visible → 3 gates. 0 leftover verticals. tallies = 3×5 + 0 = 15. total = 7 + 15 = 22.
- "Bell Pepper — 10cs ||||/ ||||"
  → 1 slash visible → 1 gate. 4 leftover verticals (no slash). tallies = 1×5 + 4 = 9. total = 10 + 9 = 19.
- "Chicken — 15cs ||||/ ||||/ ||"
  → 2 slashes visible → 2 gates. 2 leftover verticals. tallies = 2×5 + 2 = 12. total = 15 + 12 = 27.

Rules for HD / PMB lines (Layout A tally format):
1) total_quantity = initial number + tally count (computed using the gate convention above).
2) Set quantity = total. Set unit = "case" unless explicitly otherwise.
3) Set quantity_raw to the visible breakdown, e.g. "7cs + 3 gates" or "4cs + 2 strokes".
4) Set notes to "initial=<n>, gates=<n>, loose=<n>, tallies=<n>, total=<n>" so the breakdown is auditable.

Rules for In Person Shopping lines (Layout B bare-integer format):
1) The integer next to each item IS the final quantity. No tally math.
2) Set quantity = integer. Set quantity_raw = "<integer>". Set unit = "case".
3) Set notes = "ips: total=<n>". Do NOT include "initial=", "gates=", "loose=" — those don't apply.
4) Skip ALL gate-counting rules above for IPS lines.

Shared rules (both layouts):
5) Preserve item phrasing in item_name_raw. Clean up to title case in item_name_normalized.
6) Extract the header date as YYYY-MM-DD if visible. Accept M/D/YY or M/D/YYYY formats (e.g. "5/20/26" → "2026-05-20", "5/20/2026" → "2026-05-20"). If only a partial date, infer the year from context.
7) Categorize each item: produce, meat_protein, dairy, shelf_stable, frozen, non_food, unknown.
8) Set program_type per line as described in the "Program tagging" section above. Every line MUST have a program_type.
9) Set confidence 0.0-1.0. Lower confidence when:
   - Tally groupings are ambiguous (can't tell where one gate ends and next begins)
   - The slash through a gate is faint or missing
   - The initial number is partially obscured
   - You're uncertain whether an item belongs inside the PMB box vs the main HD area
10) Add source_warnings for any line where you're uncertain about the tally count, the integer, or the program assignment.
11) Output JSON only — no markdown fences, no prose.`;

// Lazy-loaded few-shot images keyed by filename.
const exampleImageCache: Map<string, string> = new Map();
function getExampleImageBase64(filename: string): string {
  const cached = exampleImageCache.get(filename);
  if (cached != null) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "examples", filename);
  const b64 = readFileSync(path).toString("base64");
  exampleImageCache.set(filename, b64);
  return b64;
}

// Example 1 — Home Delivery whiteboard (Layout A, tally format)
const EXAMPLE_HD_USER_PROMPT = `Filename: whiteboard_001.jpg

Extract every line from this whiteboard. Apply the gate counting rules from the system prompt. Return ONLY valid JSON.`;

const EXAMPLE_HD_ASSISTANT_RESPONSE = JSON.stringify({
  date: "2026-04-30",
  line_items: [
    { item_name_raw: "Onions - 12cs", item_name_normalized: "Onions", quantity: 12, quantity_raw: "12cs + 0 tallies", unit: "case", category: "produce", notes: "initial=12, gates=0, loose=0, tallies=0, total=12", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Potatoes - 12cs", item_name_normalized: "Potatoes", quantity: 22, quantity_raw: "12cs + 2 gates", unit: "case", category: "produce", notes: "initial=12, gates=2, loose=0, tallies=10, total=22", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Cabbage - 7cs", item_name_normalized: "Cabbage", quantity: 22, quantity_raw: "7cs + 3 gates", unit: "case", category: "produce", notes: "initial=7, gates=3, loose=0, tallies=15, total=22", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Butternut Squash - 8cs", item_name_normalized: "Butternut Squash", quantity: 18, quantity_raw: "8cs + 2 gates", unit: "case", category: "produce", notes: "initial=8, gates=2, loose=0, tallies=10, total=18", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Cucumbers - 10cs", item_name_normalized: "Cucumbers", quantity: 10, quantity_raw: "10cs + 0 tallies", unit: "case", category: "produce", notes: "initial=10, gates=0, loose=0, tallies=0, total=10", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Eggplant - 8cs", item_name_normalized: "Eggplant", quantity: 11, quantity_raw: "8cs + 3 strokes", unit: "case", category: "produce", notes: "initial=8, gates=0, loose=3, tallies=3, total=11", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Yellow Bell Pepper - 10cs", item_name_normalized: "Yellow Bell Pepper", quantity: 20, quantity_raw: "10cs + 2 gates", unit: "case", category: "produce", notes: "initial=10, gates=2, loose=0, tallies=10, total=20", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Broccoli - 4cs", item_name_normalized: "Broccoli", quantity: 14, quantity_raw: "4cs + 2 gates", unit: "case", category: "produce", notes: "initial=4, gates=2, loose=0, tallies=10, total=14", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Kale - 6cs", item_name_normalized: "Kale", quantity: 10, quantity_raw: "6cs + 4 strokes", unit: "case", category: "produce", notes: "initial=6, gates=0, loose=4, tallies=4, total=10", confidence: 0.9, program_type: "home_delivery" },
    { item_name_raw: "Bok Choy - 3cs", item_name_normalized: "Bok Choy", quantity: 3, quantity_raw: "3cs + 0 tallies", unit: "case", category: "produce", notes: "initial=3, gates=0, loose=0, tallies=0, total=3", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Cucumber - 6cs", item_name_normalized: "Cucumber", quantity: 6, quantity_raw: "6cs + 0 tallies", unit: "case", category: "produce", notes: "initial=6, gates=0, loose=0, tallies=0, total=6", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Grey Squash - 8cs", item_name_normalized: "Grey Squash", quantity: 8, quantity_raw: "8cs + 0 tallies", unit: "case", category: "produce", notes: "initial=8, gates=0, loose=0, tallies=0, total=8", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Carrots - 4cs", item_name_normalized: "Carrots", quantity: 4, quantity_raw: "4cs + 0 tallies", unit: "case", category: "produce", notes: "initial=4, gates=0, loose=0, tallies=0, total=4", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Cilantro - 4cs", item_name_normalized: "Cilantro", quantity: 4, quantity_raw: "4cs + 0 tallies", unit: "case", category: "produce", notes: "initial=4, gates=0, loose=0, tallies=0, total=4", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Apples - 4cs", item_name_normalized: "Apples", quantity: 6, quantity_raw: "4cs + 2 strokes", unit: "case", category: "produce", notes: "initial=4, gates=0, loose=2, tallies=2, total=6", confidence: 0.9, program_type: "home_delivery" },
    { item_name_raw: "Oranges - 6cs", item_name_normalized: "Oranges", quantity: 14, quantity_raw: "6cs + 1 gate + 3 strokes", unit: "case", category: "produce", notes: "initial=6, gates=1, loose=3, tallies=8, total=14", confidence: 0.85, program_type: "home_delivery" },
    { item_name_raw: "Bananas - 4cs", item_name_normalized: "Bananas", quantity: 4, quantity_raw: "4cs + 0 tallies", unit: "case", category: "produce", notes: "initial=4, gates=0, loose=0, tallies=0, total=4", confidence: 0.95, program_type: "home_delivery" },
    { item_name_raw: "Chicken - 15cs", item_name_normalized: "Chicken", quantity: 27, quantity_raw: "15cs + 2 gates + 2 strokes", unit: "case", category: "meat_protein", notes: "initial=15, gates=2, loose=2, tallies=12, total=27", confidence: 0.85, program_type: "home_delivery" }
  ],
  source_warnings: []
});

// Example 2 — In Person Shopping paper (Layout B, bare integers)
const EXAMPLE_IPS_USER_PROMPT = `Filename: whiteboard_ips_001.jpg

Extract every line from this paper. This is the IPS layout — items are bare integers, no tallies. Return ONLY valid JSON.`;

const EXAMPLE_IPS_ASSISTANT_RESPONSE = JSON.stringify({
  date: "2026-05-20",
  line_items: [
    { item_name_raw: "Bak choi 14", item_name_normalized: "Bok Choi", quantity: 14, quantity_raw: "14", unit: "case", category: "produce", notes: "ips: total=14", confidence: 0.9, program_type: "in_person_shopping" },
    { item_name_raw: "Sweet Potato 7", item_name_normalized: "Sweet Potato", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Red Potato 2", item_name_normalized: "Red Potato", quantity: 2, quantity_raw: "2", unit: "case", category: "produce", notes: "ips: total=2", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Russet Potato 8", item_name_normalized: "Russet Potato", quantity: 8, quantity_raw: "8", unit: "case", category: "produce", notes: "ips: total=8", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Carrot 10", item_name_normalized: "Carrot", quantity: 10, quantity_raw: "10", unit: "case", category: "produce", notes: "ips: total=10", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Beet 7", item_name_normalized: "Beet", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Cabbage 7", item_name_normalized: "Cabbage", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Cucumber 3", item_name_normalized: "Cucumber", quantity: 3, quantity_raw: "3", unit: "case", category: "produce", notes: "ips: total=3", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Corn 13", item_name_normalized: "Corn", quantity: 13, quantity_raw: "13", unit: "case", category: "produce", notes: "ips: total=13", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Cilantro 7", item_name_normalized: "Cilantro", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Zuchinni 7", item_name_normalized: "Zucchini", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.9, program_type: "in_person_shopping" },
    { item_name_raw: "Green Onion 7", item_name_normalized: "Green Onion", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Egg Plant 10", item_name_normalized: "Eggplant", quantity: 10, quantity_raw: "10", unit: "case", category: "produce", notes: "ips: total=10", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Peach 13", item_name_normalized: "Peach", quantity: 13, quantity_raw: "13", unit: "case", category: "produce", notes: "ips: total=13", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Pear 8", item_name_normalized: "Pear", quantity: 8, quantity_raw: "8", unit: "case", category: "produce", notes: "ips: total=8", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Orange 5", item_name_normalized: "Orange", quantity: 5, quantity_raw: "5", unit: "case", category: "produce", notes: "ips: total=5", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Apple Green 2", item_name_normalized: "Green Apple", quantity: 2, quantity_raw: "2", unit: "case", category: "produce", notes: "ips: total=2", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Yellow Apple 5", item_name_normalized: "Yellow Apple", quantity: 5, quantity_raw: "5", unit: "case", category: "produce", notes: "ips: total=5", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Red Apple 2", item_name_normalized: "Red Apple", quantity: 2, quantity_raw: "2", unit: "case", category: "produce", notes: "ips: total=2", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Yellow Onion 5", item_name_normalized: "Yellow Onion", quantity: 5, quantity_raw: "5", unit: "case", category: "produce", notes: "ips: total=5", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Grey Squash 7", item_name_normalized: "Grey Squash", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Avocado 10", item_name_normalized: "Avocado", quantity: 10, quantity_raw: "10", unit: "case", category: "produce", notes: "ips: total=10", confidence: 0.95, program_type: "in_person_shopping" },
    { item_name_raw: "Broccoli 7", item_name_normalized: "Broccoli", quantity: 7, quantity_raw: "7", unit: "case", category: "produce", notes: "ips: total=7", confidence: 0.95, program_type: "in_person_shopping" }
  ],
  source_warnings: []
});

export async function extractFromWhiteboard(params: {
  imageBytes: Buffer;
  mimeType: string;
  filename: string;
}): Promise<EodExtractionResult> {
  const userPrompt = `Filename: ${params.filename}

Extract every line from this photo. First, identify the layout (Home Delivery / Pre Made Bags shared whiteboard, or In Person Shopping paper) and tag each line's program_type accordingly. Apply the appropriate quantity rules from the system prompt. Return ONLY valid JSON matching this schema:

{
  "date": "YYYY-MM-DD" | null,
  "line_items": [
    {
      "item_name_raw": string | null,
      "item_name_normalized": string | null,
      "quantity": number | null,
      "quantity_raw": string | null,
      "unit": "case" | "bag" | "pallet" | "lb" | "oz" | "ct" | "ea" | "other" | null,
      "category": "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown",
      "notes": string | null,
      "confidence": 0.0-1.0,
      "program_type": "home_delivery" | "in_person_shopping" | "pre_made_bags" | "unknown"
    }
  ],
  "source_warnings": string[]
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 4000 },
    system: WHITEBOARD_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: getExampleImageBase64("whiteboard_001.jpg") }
          },
          { type: "text", text: EXAMPLE_HD_USER_PROMPT }
        ]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: EXAMPLE_HD_ASSISTANT_RESPONSE }]
      },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: getExampleImageBase64("whiteboard_ips_001.jpg") }
          },
          { type: "text", text: EXAMPLE_IPS_USER_PROMPT, cache_control: { type: "ephemeral" } }
        ]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: EXAMPLE_IPS_ASSISTANT_RESPONSE }]
      },
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: mimeToMediaType(params.mimeType),
              data: params.imageBytes.toString("base64")
            }
          },
          { type: "text", text: userPrompt }
        ]
      }
    ]
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response returned by Claude.");
  }

  const parsed = eodExtractionSchema.safeParse(JSON.parse(sanitizeJson(textBlock.text)));
  if (!parsed.success) {
    throw new Error(`Whiteboard extraction schema validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}

export async function transcribeAudio(audioBytes: Buffer, mimeType: string, filename: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set — voice memo transcription is unavailable.");
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audioBytes)], { type: mimeType }), filename);
  form.append("model", "whisper-1");

  const response = await axios.post<{ text: string }>(
    "https://api.openai.com/v1/audio/transcriptions",
    form,
    { headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` } }
  );

  return response.data.text;
}
