import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { env } from "./config.js";
import { loadPrompt } from "./prompts.js";
import type { ExtractionResult, ExtractionTrace, EodExtractionResult, Supplier } from "./types.js";

const EXTRACTION_MODEL = "claude-opus-4-8";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const extractionSchema = z.object({
  document_type: z.enum(["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"]),
  supplier: z.enum(["carusos", "charlies", "costco", "food_lifeline", "grand_central", "grocery_rescue", "nw_harvest", "pacific", "terrebonne", "weigelt", "unknown"]),
  invoice_date: z.string().nullable(),
  delivery_date: z.string().nullable(),
  invoice_or_order_number: z.string().nullable(),
  destination_org: z.string().nullable(),
  donor_org: z.string().nullable(),
  is_donation: z.boolean().nullable(),
  line_items: z.array(
    z.object({
      item_code_raw: z.string().nullable(),
      item_name_raw: z.string().nullable(),
      item_name_normalized: z.string().nullable(),
      quantity_ordered: z.number().nullable(),
      quantity: z.number().nullable(),
      quantity_raw: z.string().nullable(),
      unit: z.enum(["case", "ct", "lb", "oz", "ea", "bushel", "other"]).nullable(),
      pack_size_raw: z.string().nullable(),
      approx_weight: z.number().nullable(),
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

const SYSTEM_PROMPT = loadPrompt("invoice/system.md");

const SUPPLIER_PROMPTS: Record<Supplier, string> = {
  carusos: loadPrompt("invoice/suppliers/carusos.md"),
  charlies: loadPrompt("invoice/suppliers/charlies.md"),
  costco: loadPrompt("invoice/suppliers/costco.md"),
  food_lifeline: loadPrompt("invoice/suppliers/food_lifeline.md"),
  grand_central: loadPrompt("invoice/suppliers/grand_central.md"),
  grocery_rescue: loadPrompt("invoice/suppliers/grocery_rescue.md"),
  in_kind: loadPrompt("invoice/suppliers/unknown.md"),
  nw_harvest: loadPrompt("invoice/suppliers/nw_harvest.md"),
  pacific: loadPrompt("invoice/suppliers/pacific.md"),
  terrebonne: loadPrompt("invoice/suppliers/terrebonne.md"),
  weigelt: loadPrompt("invoice/suppliers/weigelt.md"),
  unknown: loadPrompt("invoice/suppliers/unknown.md")
};

export function getInvoiceSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function getInvoiceSupplierPrompt(supplier: string): string | null {
  const key = supplier as Supplier;
  return SUPPLIER_PROMPTS[key] ?? null;
}

export const INVOICE_SUPPLIER_KEYS: Supplier[] = Object.keys(SUPPLIER_PROMPTS) as Supplier[];

// ── Tool schemas (force Claude to return structured JSON via tool_use) ────────

const EXTRACTION_TOOL_NAME = "submit_delivery_extraction";
const EOD_TOOL_NAME = "submit_eod_extraction";

const EXTRACTION_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    document_type: { type: "string", enum: ["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"] },
    supplier: { type: "string", enum: ["carusos", "charlies", "costco", "food_lifeline", "grand_central", "grocery_rescue", "nw_harvest", "pacific", "terrebonne", "weigelt", "unknown"] },
    invoice_date: { type: ["string", "null"], description: "The date printed on the invoice/document (labels vary: 'Invoice date', 'Order date', 'Date'). Format YYYY-MM-DD. When the document shows both an invoice date and a distinct ship/delivery date, they go in separate columns. When the document shows only one date, populate BOTH invoice_date and delivery_date with that same value — do not leave either null." },
    delivery_date: { type: ["string", "null"], description: "The date the goods physically shipped or arrived (labels vary: 'Ship date', 'Shipped on', 'Delivered', 'Received'). Format YYYY-MM-DD. When the document shows only one date, populate BOTH invoice_date and delivery_date with that same value." },
    invoice_or_order_number: { type: ["string", "null"] },
    destination_org: { type: ["string", "null"] },
    donor_org: { type: ["string", "null"], description: "The party that contributed the goods, when distinct from the supplier (e.g., the grocery store on a Food Lifeline grocery rescue form: 'QFC-MI', 'Safeway-RB'). Null when the supplier is itself the donor." },
    is_donation: { type: ["boolean", "null"], description: "True if the document indicates the goods are a donation; false if explicitly purchased; null if the document doesn't say." },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_code_raw: { type: ["string", "null"] },
          item_name_raw: { type: ["string", "null"] },
          item_name_normalized: { type: ["string", "null"] },
          quantity_ordered: { type: ["number", "null"], description: "Cases the food bank ORDERED (from the ORDER/ORDERED column). Null if the document only shows one quantity." },
          quantity: { type: ["number", "null"], description: "Cases actually SHIPPED/RECEIVED (from the SHIP/SHIPPED/Qty column). Authoritative inventory count." },
          quantity_raw: { type: ["string", "null"] },
          unit: { type: ["string", "null"], enum: ["case", "ct", "lb", "oz", "ea", "bushel", "other", null] },
          pack_size_raw: { type: ["string", "null"] },
          approx_weight: { type: ["number", "null"], description: "Approximate total weight in pounds from the APPROX.WT. / Weight column, if present." },
          category: { type: "string", enum: ["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"] },
          unit_cost: { type: ["number", "null"] },
          line_total: { type: ["number", "null"] },
          is_fee: { type: "boolean" },
          notes: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["item_code_raw", "item_name_raw", "item_name_normalized", "quantity_ordered", "quantity", "quantity_raw", "unit", "pack_size_raw", "approx_weight", "category", "unit_cost", "line_total", "is_fee", "notes", "confidence"]
      }
    },
    fees: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: ["number", "null"] }
        },
        required: ["description", "amount"]
      }
    },
    totals: {
      type: "object",
      properties: {
        subtotal: { type: ["number", "null"] },
        tax: { type: ["number", "null"] },
        grand_total: { type: ["number", "null"] }
      },
      required: ["subtotal", "tax", "grand_total"]
    },
    source_warnings: { type: "array", items: { type: "string" } }
  },
  required: ["document_type", "supplier", "invoice_date", "delivery_date", "invoice_or_order_number", "destination_org", "donor_org", "is_donation", "line_items", "fees", "totals", "source_warnings"]
};

const EOD_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    date: { type: ["string", "null"] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_name_raw: { type: ["string", "null"] },
          item_name_normalized: { type: ["string", "null"] },
          quantity: { type: ["number", "null"] },
          quantity_raw: { type: ["string", "null"] },
          unit: { type: ["string", "null"], enum: ["case", "bag", "pallet", "lb", "oz", "ct", "ea", "other", null] },
          category: { type: "string", enum: ["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"] },
          notes: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["item_name_raw", "item_name_normalized", "quantity", "quantity_raw", "unit", "category", "notes", "confidence"]
      }
    },
    source_warnings: { type: "array", items: { type: "string" } }
  },
  required: ["date", "line_items", "source_warnings"]
};

// ── Error logging helpers ─────────────────────────────────────────────────────

function previewRaw(raw: string, max = 800): string {
  return raw.length > max ? `${raw.slice(0, max)}…[truncated, total ${raw.length} chars]` : raw;
}

function getToolInputOrThrow(label: string, content: readonly unknown[], toolName: string): unknown {
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "tool_use" &&
      (block as { name?: unknown }).name === toolName
    ) {
      return (block as { input: unknown }).input;
    }
  }
  const textFallback = content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"
    )
    .map((b) => b.text)
    .join("\n");
  console.error(`[${label}] Expected tool_use "${toolName}" missing. Text content:\n${previewRaw(textFallback)}`);
  throw new Error(`${label}: model did not call tool ${toolName}`);
}

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
  if (f.includes("costco")) return "costco";
  if (f.includes("grand_central") || f.includes("grand-central") || f.includes("grandcentral") || f.includes("gcb")) return "grand_central";
  // Food Lifeline umbrella covers two very different subtypes: printed
  // agency-order manifests (supplier="food_lifeline") vs handwritten grocery
  // rescue slips (supplier="grocery_rescue"). Filename alone can't distinguish
  // them — route to "unknown" and let the extraction prompt classify off the
  // image.
  if (f.includes("food lifeline") || f.includes("food_lifeline") || f.includes("foodlifeline") || f.includes("lifeline")) return "unknown";
  if (f.includes("grocery_rescue") || f.includes("grocery-rescue") || f.includes("grocery rescue") || f.includes("rescue")) return "grocery_rescue";
  if (f.includes("harvest") || f.includes("nw")) return "nw_harvest";
  if (f.includes("pacific") || f.includes("pfd")) return "pacific";
  if (f.includes("terrebonne") || f.includes("truck_patch") || f.includes("truck-patch") || f.includes("truckpatch") || f.includes("ttp")) return "terrebonne";
  if (f.includes("weigelt")) return "weigelt";
  return "unknown";
}

function mimeToMediaType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes("png")) return "image/png";
  if (normalized.includes("gif")) return "image/gif";
  if (normalized.includes("webp")) return "image/webp";
  return "image/jpeg";
}

function isPdfMime(mimeType: string): boolean {
  return mimeType.toLowerCase().includes("pdf");
}

export async function extractFromImage(params: {
  imageBytes: Buffer;
  mimeType: string;
  filename: string;
  supplierHint: Supplier;
}): Promise<{ result: ExtractionResult; trace: ExtractionTrace }> {
  const { imageBytes, mimeType, filename, supplierHint } = params;

  const isPdf = isPdfMime(mimeType);
  const sourceKind = isPdf ? "PDF" : "image";

  const today = new Date().toISOString().slice(0, 10);

  const userPrompt = `${SUPPLIER_PROMPTS[supplierHint]}

Filename: ${filename}
Today's date: ${today}

Analyze the attached ${sourceKind}, then call the ${EXTRACTION_TOOL_NAME} tool with the extracted delivery line items.`;

  const documentBlock = isPdf
    ? {
        type: "document" as const,
        source: {
          type: "base64" as const,
          media_type: "application/pdf" as const,
          data: imageBytes.toString("base64")
        }
      }
    : {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: mimeToMediaType(mimeType),
          data: imageBytes.toString("base64")
        }
      };

  const stream = client.messages.stream({
    model: EXTRACTION_MODEL,
    max_tokens: 32768,
    output_config: { effort: "xhigh" },
    thinking: { type: "adaptive", display: "summarized" },
    system: SYSTEM_PROMPT,
    tools: [
      {
        name: EXTRACTION_TOOL_NAME,
        description: "Submit the extracted delivery data from a food-bank invoice, manifest, or dock photo.",
        input_schema: EXTRACTION_INPUT_SCHEMA as never
      }
    ],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: [
          documentBlock,
          {
            type: "text",
            text: userPrompt
          }
        ]
      }
    ]
  });

  const response = await stream.finalMessage();

  const thinkingParts: string[] = [];
  for (const block of response.content) {
    if (block.type === "thinking") {
      thinkingParts.push(block.thinking);
      console.log(`[extractFromImage:thinking ${filename}]\n${block.thinking}`);
    }
  }

  const toolInput = getToolInputOrThrow("extractFromImage", response.content, EXTRACTION_TOOL_NAME);

  const parsed = extractionSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error(`[extractFromImage] Schema validation failed. Tool input:\n${previewRaw(JSON.stringify(toolInput))}`);
    throw new Error(`Extraction schema validation failed: ${parsed.error.message}`);
  }

  // Anthropic SDK exposes usage on the final message; fall back to null if the
  // shape changes across SDK versions.
  const usage = (response as unknown as { usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } }).usage;

  const trace: ExtractionTrace = {
    filename,
    supplierHint,
    model: EXTRACTION_MODEL,
    thinking: thinkingParts.join("\n\n---\n\n"),
    rawToolInput: JSON.stringify(toolInput),
    inputTokens: usage?.input_tokens ?? null,
    outputTokens: usage?.output_tokens ?? null,
    cacheCreationTokens: usage?.cache_creation_input_tokens ?? null,
    cacheReadTokens: usage?.cache_read_input_tokens ?? null
  };

  return { result: parsed.data, trace };
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

const EOD_SYSTEM_PROMPT = loadPrompt("eod/system.md");

export async function extractFromText(text: string): Promise<EodExtractionResult> {
  const userPrompt = `Extract all inventory items from the following end-of-day count, then call the ${EOD_TOOL_NAME} tool with the result.

Text:
${text}`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 2048,
    system: EOD_SYSTEM_PROMPT,
    tools: [
      {
        name: EOD_TOOL_NAME,
        description: "Submit the extracted end-of-day inventory counts.",
        input_schema: EOD_INPUT_SCHEMA as never
      }
    ],
    tool_choice: { type: "tool", name: EOD_TOOL_NAME },
    messages: [{ role: "user", content: userPrompt }]
  });

  const toolInput = getToolInputOrThrow("extractFromText", response.content, EOD_TOOL_NAME);

  const parsed = eodExtractionSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error(`[extractFromText] Schema validation failed. Tool input:\n${previewRaw(JSON.stringify(toolInput))}`);
    throw new Error(`EOD extraction schema validation failed: ${parsed.error.message}`);
  }

  return parsed.data;
}

// ── Image classification (whiteboard vs invoice) ──────────────────────────────

export async function classifyImage(params: {
  imageBytes: Buffer;
  mimeType: string;
}): Promise<"whiteboard" | "invoice"> {
  // PDFs are always printed invoices/manifests; whiteboards are only photographed.
  if (isPdfMime(params.mimeType)) return "invoice";

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 16,
    system: loadPrompt("classify/system.md"),
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
          { type: "text", text: loadPrompt("classify/user.md") }
        ]
      }
    ]
  });

  const textBlock = response.content.find((block) => block.type === "text");
  if (!textBlock || textBlock.type !== "text") return "invoice";
  return textBlock.text.trim().toLowerCase().includes("whiteboard") ? "whiteboard" : "invoice";
}

// ── Whiteboard outbound extraction ────────────────────────────────────────────

const WHITEBOARD_SYSTEM_PROMPT = loadPrompt("whiteboard/system.md");

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
const EXAMPLE_HD_USER_PROMPT = loadPrompt("whiteboard/examples/hd_user.md");

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
const EXAMPLE_IPS_USER_PROMPT = loadPrompt("whiteboard/examples/ips_user.md");

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

  const sanitized = sanitizeJson(textBlock.text);
  let json: unknown;
  try {
    json = JSON.parse(sanitized);
  } catch (error) {
    console.error(`[extractWhiteboard] JSON.parse failed. Raw model output:\n${previewRaw(sanitized)}`);
    throw error;
  }

  const parsed = eodExtractionSchema.safeParse(json);
  if (!parsed.success) {
    console.error(`[extractWhiteboard] Schema validation failed. Parsed JSON:\n${previewRaw(JSON.stringify(json))}`);
    throw new Error(`Whiteboard extraction schema validation failed: ${parsed.error.message}`);
  }

  // Pre-made bags are tracked by bag count, not by contents. Override the item
  // name so both raw and normalized columns read "pre_made_bags" / "Pre Made Bags".
  const normalized = {
    ...parsed.data,
    line_items: parsed.data.line_items.map((li) =>
      li.program_type === "pre_made_bags"
        ? { ...li, item_name_raw: "pre_made_bags", item_name_normalized: "Pre Made Bags" }
        : li
    )
  };

  return normalized;
}

// ── Grocery rescue skeleton fill ──────────────────────────────────────────
//
// Every Food Lifeline grocery rescue slip has a fixed set of 10 category rows
// on the paper form. The prompt asks the extractor to always emit all 10, but
// LLMs sometimes drop the empty ones. This helper deterministically enforces
// the invariant so reviewers always see the full skeleton and can fill in a
// missing value without adding a row by hand.

export const RESCUE_CATEGORIES: Array<{
  label: string;
  normalized: string;
  matchKeys: string[];
  category: "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food";
}> = [
  { label: "Bakery",                        normalized: "Bakery",                     matchKeys: ["bakery"],                       category: "shelf_stable" },
  { label: "Canned/Dry Goods",              normalized: "Canned / Dry Goods",         matchKeys: ["canneddrygoods", "canned"],     category: "shelf_stable" },
  { label: "Coffee Kiosk",                  normalized: "Coffee Kiosk",               matchKeys: ["coffeekiosk", "coffee"],        category: "shelf_stable" },
  { label: "Dairy/Juice/Alt. Dairy",        normalized: "Dairy / Juice / Alt. Dairy", matchKeys: ["dairyjuicealtdairy", "dairy"],  category: "dairy" },
  { label: "Frozen Foods",                  normalized: "Frozen Foods",               matchKeys: ["frozenfoods", "frozen"],        category: "frozen" },
  { label: "Meat",                          normalized: "Meat",                       matchKeys: ["meat"],                         category: "meat_protein" },
  { label: "Nonfood",                       normalized: "Nonfood",                    matchKeys: ["nonfood"],                      category: "non_food" },
  { label: "Non-Meat Protein (eggs, tofu)", normalized: "Non-Meat Protein",           matchKeys: ["nonmeatprotein", "eggstofu"],   category: "dairy" },
  { label: "Prepared/Perishable",           normalized: "Prepared / Perishable",      matchKeys: ["preparedperishable", "prepared"], category: "produce" },
  { label: "Produce",                       normalized: "Produce",                    matchKeys: ["produce"],                      category: "produce" }
];

function normKey(s: string | null): string {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

// Canonical short codes for the 5 grocery rescue donor locations. Extractor
// output goes through normalizeRescueDonor() before any dedupe / write so that
// even if the LLM emits a variant (or an older canonical from a stale prompt),
// downstream code sees exactly one of these 5 strings.
export const RESCUE_DONOR_CANONICAL = ["QFC-MI", "QFC-BWY", "SWY-RB", "SWY-GEN", "Homegrown"] as const;

function normDonorKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

// Map any handwritten / historical donor string to one of the 5 canonicals.
// Order matters: longer / more specific matches first so "swyrb" doesn't match
// "safeway" before "rb".
const RESCUE_DONOR_ALIASES: Array<{ canonical: typeof RESCUE_DONOR_CANONICAL[number]; keys: string[] }> = [
  { canonical: "QFC-MI",   keys: ["qfcmi", "miqfc", "qfcmercerisland", "qfcmercer"] },
  { canonical: "QFC-BWY",  keys: ["qfcbwy", "qfcb", "qfcbw", "qfcbrdwy", "qfcbroadway"] },
  { canonical: "SWY-RB",   keys: ["swyrb", "safewayrb", "safewayrainierbeach", "safewayrainier", "rbsafeway"] },
  { canonical: "SWY-GEN",  keys: ["swygen", "safewayg", "safewaygen", "safewaygenesee", "gensafeway"] },
  { canonical: "Homegrown", keys: ["homegrown", "homegrown", "hg"] }
];

export function normalizeRescueDonor(raw: string | null): string | null {
  if (!raw) return null;
  const key = normDonorKey(raw);
  if (!key) return null;
  if ((RESCUE_DONOR_CANONICAL as readonly string[]).includes(raw)) return raw; // already canonical
  for (const entry of RESCUE_DONOR_ALIASES) {
    if (entry.keys.some((k) => key === k || key.includes(k))) return entry.canonical;
  }
  return null;
}

// Normalize an extractor result for grocery rescue slips: forces donor_org
// onto one of the 5 canonicals and (re)synthesizes invoice_or_order_number
// as `<canonical>-<delivery_date>`. Runs before ensureRescueSkeleton in the
// ingest path so downstream code (dedupe, review UI, backfill) sees canonical
// donor names regardless of what the LLM emitted.
export function normalizeRescueSlip(extraction: ExtractionResult): void {
  if (extraction.supplier !== "grocery_rescue") return;
  if (!extraction.donor_org) return;
  const canonical = normalizeRescueDonor(extraction.donor_org);
  if (!canonical) {
    extraction.source_warnings.push(
      `donor_org unrecognized: "${extraction.donor_org}" — expected one of QFC-MI / QFC-BWY / SWY-RB / SWY-GEN / Homegrown`
    );
    extraction.donor_org = null;
    extraction.invoice_or_order_number = null;
    return;
  }
  if (extraction.donor_org !== canonical) {
    extraction.donor_org = canonical;
  }
  if (extraction.delivery_date) {
    const synthesized = `${canonical}-${extraction.delivery_date}`;
    if (extraction.invoice_or_order_number !== synthesized) {
      extraction.invoice_or_order_number = synthesized;
    }
  }
}

export function ensureRescueSkeleton(extraction: ExtractionResult): void {
  if (extraction.supplier !== "grocery_rescue") return;
  if (!extraction.donor_org || !extraction.donor_org.trim()) return;

  const items = extraction.line_items;
  const output: typeof items = [];
  const usedIndexes = new Set<number>();

  for (const cat of RESCUE_CATEGORIES) {
    let matchIndex = -1;
    // Non-Meat Protein must beat Meat: check its exact match keys first.
    const rawKey = normKey(cat.matchKeys[0]);
    // Priority 1: exact normalized-key match against item_name_raw / _normalized.
    for (let i = 0; i < items.length; i++) {
      if (usedIndexes.has(i)) continue;
      const li = items[i];
      if (normKey(li.item_name_raw) === rawKey || normKey(li.item_name_normalized) === normKey(cat.normalized)) {
        matchIndex = i; break;
      }
    }
    // Priority 2: match any of the fuzzy keys (contains). Skip Meat's "meat"
    // key from also matching a Non-Meat Protein row already claimed.
    if (matchIndex === -1) {
      for (let i = 0; i < items.length; i++) {
        if (usedIndexes.has(i)) continue;
        const li = items[i];
        const raw = normKey(li.item_name_raw);
        const norm = normKey(li.item_name_normalized);
        if (cat.matchKeys.some((k) => raw === k || norm === k || raw.includes(k) || norm.includes(k))) {
          // Guard: "meat" also appears in "nonmeatprotein" — don't let the Meat
          // category eat a Non-Meat Protein row.
          if (cat.label === "Meat" && (raw.includes("nonmeat") || norm.includes("nonmeat"))) continue;
          matchIndex = i; break;
        }
      }
    }
    if (matchIndex !== -1) {
      output.push(items[matchIndex]);
      usedIndexes.add(matchIndex);
    } else {
      output.push({
        item_code_raw: null,
        item_name_raw: cat.label,
        item_name_normalized: cat.normalized,
        quantity_ordered: null,
        quantity: null,
        quantity_raw: null,
        unit: "lb",
        pack_size_raw: null,
        approx_weight: null,
        category: cat.category,
        unit_cost: null,
        line_total: null,
        is_fee: false,
        notes: "no value on form (auto-inserted skeleton)",
        confidence: 0.95
      });
    }
  }
  // Preserve any extra rows the extractor produced that didn't map to a category.
  for (let i = 0; i < items.length; i++) if (!usedIndexes.has(i)) output.push(items[i]);
  extraction.line_items = output;
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
