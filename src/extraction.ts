import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import { env } from "./config.js";
import { loadPrompt } from "./prompts.js";
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
  nw_harvest: loadPrompt("invoice/suppliers/nw_harvest.md"),
  pacific: loadPrompt("invoice/suppliers/pacific.md"),
  unknown: loadPrompt("invoice/suppliers/unknown.md")
};

// ── Tool schemas (force Claude to return structured JSON via tool_use) ────────

const EXTRACTION_TOOL_NAME = "submit_delivery_extraction";
const EOD_TOOL_NAME = "submit_eod_extraction";

const EXTRACTION_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    document_type: { type: "string", enum: ["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"] },
    supplier: { type: "string", enum: ["carusos", "charlies", "nw_harvest", "pacific", "unknown"] },
    delivery_date: { type: ["string", "null"] },
    invoice_or_order_number: { type: ["string", "null"] },
    destination_org: { type: ["string", "null"] },
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
  required: ["document_type", "supplier", "delivery_date", "invoice_or_order_number", "destination_org", "line_items", "fees", "totals", "source_warnings"]
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

Analyze the attached image, then call the ${EXTRACTION_TOOL_NAME} tool with the extracted delivery line items.`;

  const stream = client.messages.stream({
    model: "claude-opus-4-8",
    max_tokens: 32768,
    output_config: { effort: "xhigh" },
    thinking: { type: "enabled", budget_tokens: 16000 },
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

  const response = await stream.finalMessage();

  for (const block of response.content) {
    if (block.type === "thinking") {
      console.log(`[extractFromImage:thinking ${filename}]\n${block.thinking}`);
    }
  }

  const toolInput = getToolInputOrThrow("extractFromImage", response.content, EXTRACTION_TOOL_NAME);

  const parsed = extractionSchema.safeParse(toolInput);
  if (!parsed.success) {
    console.error(`[extractFromImage] Schema validation failed. Tool input:\n${previewRaw(JSON.stringify(toolInput))}`);
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
