import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "./config.js";
import type { ExtractionResult, Supplier } from "./types.js";

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
      amount: z.number()
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
- Filter out: Fuel surcharge, delivery fees (put in fees[] array)
- Ignore handwritten time notations at top of page.`,

  charlies: `Supplier: Charlie's Produce (Seattle, WA).
Document format: Customer invoice with columns ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION.
- Use SHIP quantity for inventory count.
- ITEM# => item_code_raw
- PACK SIZE => pack_size_raw (e.g., "1 40CT", "1 25LB")
- Descriptions use commas: "AVOCADO,HASS GREEN" not spaces.
- Origin codes may appear: MX (Mexico), UCA, etc. - put in notes.
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

**Charlie's Produce** (set supplier: "charlies")
- Logo says "Charlie's Produce"
- Location: Seattle, WA or PO Box 24606 or 4123 2nd Ave S
- Columns: ORDER | SHIP | ITEM# | PACK SIZE | DESCRIPTION | APPROX.WT. | PRICE | EXTENSION
- Descriptions use commas (e.g., "AVOCADO,HASS GREEN"). Use SHIP quantity. Filter out energy charge.

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
  "fees": [{ "description": string, "amount": number }],
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
