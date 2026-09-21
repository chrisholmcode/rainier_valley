// Chat over Loadslip's own inventory data.
//
// Reads Inbound Delivery Log + Outbound Delivery Log once per request, then
// runs a Sonnet tool-use loop with three read-only tools that filter/aggregate
// the in-memory data. Each request is stateless — the client sends the full
// message history on every POST. No writes to Sheets, no external network
// beyond Anthropic.

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";
import { readDeliveryRows, readEodRows } from "./sheets.js";
import type { DeliverySheetRow, EodSheetRow, ProgramType } from "./types.js";
import {
  aggregate as aggregateDashboard,
  resolveBuckets,
  monthToRange,
  type WindowSpec,
  type View
} from "./dashboard.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Sonnet is plenty for this workload; Opus is env-tunable via ANTHROPIC_MODEL
// but that also affects extraction. Pin Sonnet here so chat cost stays low
// regardless of the extraction model choice.
const CHAT_MODEL = "claude-sonnet-4-6";

const MAX_ITERATIONS = 8;
const MAX_ROWS_PER_TOOL_RESULT = 100;

// Mirror src/dashboard.ts DONATION_SUPPLIERS — kept in sync manually because
// the two modules can't share the constant without a circular import concern
// (dashboard already imports plenty of types from ./types, cleaner to duplicate).
const DONATION_SUPPLIERS = new Set<string>([
  "nw_harvest", "food_lifeline", "grocery_rescue", "hayton_farms", "grand_central"
]);

function parseBoolCell(v: string | null | undefined): boolean | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return null;
}

function isDonationRow(r: DeliverySheetRow): boolean {
  const explicit = parseBoolCell(r.is_donation);
  if (explicit != null) return explicit;
  const supplier = (r.supplier ?? "").trim().toLowerCase();
  return DONATION_SUPPLIERS.has(supplier);
}

function isFeeRow(r: DeliverySheetRow): boolean {
  return parseBoolCell(r.is_fee) === true;
}

function toNumber(v: string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function inboundPoundsFor(r: DeliverySheetRow): number | null {
  const aw = toNumber(r.approx_weight);
  if (aw > 0) return aw;
  const unit = (r.unit ?? "").trim().toLowerCase();
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds") {
    const q = toNumber(r.quantity);
    if (q > 0) return q;
  }
  return null;
}

// Tool-result shape for one inbound row — trimmed to the fields useful for
// answering questions. Slack metadata, warnings_json, and photo URLs are
// dropped to keep token count sane.
interface InboundRowSlim {
  rowIndex: number;
  delivery_date: string | null;
  supplier: string;
  invoice: string | null;
  item: string;
  quantity: number;
  unit: string | null;
  pounds: number | null;
  line_total: number | null;
  is_donation: boolean;
  is_fee: boolean;
  donor_org: string | null;
  category: string | null;
}

interface OutboundRowSlim {
  rowIndex: number;
  date: string;
  item: string;
  quantity: number;
  unit: string | null;
  category: string | null;
  program_type: ProgramType | null;
  source: string | null;
}

function slimInbound(r: DeliverySheetRow): InboundRowSlim {
  return {
    rowIndex: r.rowIndex,
    delivery_date: r.delivery_date,
    supplier: r.supplier,
    invoice: r.invoice_or_order_number,
    item: (r.item_name_normalized || r.item_name_raw || "").trim(),
    quantity: toNumber(r.quantity),
    unit: r.unit,
    pounds: inboundPoundsFor(r),
    line_total: r.line_total ? toNumber(r.line_total) : null,
    is_donation: isDonationRow(r),
    is_fee: isFeeRow(r),
    donor_org: r.donor_org,
    category: r.category
  };
}

function slimOutbound(r: EodSheetRow): OutboundRowSlim {
  return {
    rowIndex: r.rowIndex,
    date: r.date,
    item: (r.item_name_normalized || r.item_name_raw || "").trim(),
    quantity: toNumber(r.quantity),
    unit: r.unit,
    category: r.category,
    program_type: r.program_type,
    source: r.source
  };
}

function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}

function buildSystemPrompt(): Array<Anthropic.TextBlockParam> {
  // Split into a stable prefix (cache-friendly) + a today-date suffix so the
  // large stable chunk gets cached across turns even though the date rotates.
  const stable = `You are the Loadslip inventory analyst for ${env.TENANT_NAME}. Your job is to answer questions about this food bank's inbound and outbound inventory using the tools provided. You have no access to anything outside these two Google Sheets tabs.

## Data model

**Inbound Delivery Log** — one row per line item on an incoming shipment.
- Grouping key: (supplier, invoice_or_order_number) = one shipment.
- Suppliers: carusos (Caruso's Produce), charlies (Charlie's Produce), costco, food_lifeline, grand_central, grocery_rescue, hayton_farms, in_kind, nw_harvest (Northwest Harvest), pacific (Pacific Coast Fruit), terrebonne, weigelt, unknown.
- Pounds derivation: prefer approx_weight; if missing and unit is "lb", fall back to quantity; otherwise pounds = null (row is "unweighed"). Never invent pounds when both signals are absent.
- Donation vs purchased: is_donation column is the source of truth. When the column is blank, treat these suppliers as donations by convention: nw_harvest, food_lifeline, grocery_rescue, hayton_farms, grand_central. Everything else defaults to purchased.
- Fees (is_fee=true) are shipping/handling charges, NOT inventory. Exclude them from pounds and food-value questions but include them in the invoice grand total if asked about total supplier billing.
- line_total is the dollar amount on the invoice line. For "how much did we spend on food" questions, sum line_total across NON-donation, NON-fee rows only.

**Outbound Delivery Log** — one row per line item leaving the food bank.
- Sources: whiteboard (photo of dry-erase distribution tally), text (Slack "eod: ..." message), voice (voice-memo transcription).
- program_type: home_delivery, in_person_shopping, pre_made_bags, or unknown. Unknown/null usually means it was recorded before program tagging was added.
- Outbound is measured in CASES, not pounds. Do not attempt pound conversions unless the row explicitly says unit=lb.

## Behavior rules
1. Always call a tool before quoting a number. Never make up totals.
2. Prefer get_dashboard_metrics for range aggregates (pounds/cases/purchase price by day or week). Fall back to query_inbound / query_outbound when you need row-level detail (e.g. "list Caruso's items last Thursday").
3. Dates are always America/Los_Angeles YYYY-MM-DD. Convert relative phrases ("last week", "yesterday", "August") before calling tools. Weeks are Sunday–Saturday.
4. Cap query_inbound / query_outbound results at 100 rows. If a query would return more, narrow the date range or add filters and note the truncation in your answer.
5. When the user asks for a CSV, export, spreadsheet, or download — even implicitly ("send me the numbers", "give me a file") — use create_download. It writes ALL matching rows to a server-side CSV; the user gets a download button automatically. Pick a descriptive filename (supplier + month, direction + range, etc.). After calling it, describe what's in the file: row count, date range, any filters applied. Do NOT paste the download_id into your reply.
6. When you cite a number, mention the date range and any filter you applied ("Aug 1–7, purchased only") so the user can verify.
7. Be concise. Bullet key numbers instead of long paragraphs. Round pounds to whole numbers and money to whole dollars unless the user asks otherwise.
8. If a question is out of scope (asks about something not in these two sheets — donors' financials, staffing, HR, weather), say so briefly and suggest what you CAN answer.
9. Never propose sheet edits. You are read-only.`;

  const dynamic = `\n\nToday is ${todayIso()} (PT).`;

  return [
    { type: "text", text: stable, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamic }
  ];
}

// ── Download store ────────────────────────────────────────────────────────
// In-memory store for CSVs generated by the create_download tool. Kept small
// and TTL-scoped since a Railway restart flushes them anyway — anyone who
// tries to redeem a stale link just gets a 404 and can re-ask the chat.

const DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_STORE_MAX = 200;

interface StoredDownload {
  filename: string;
  csv: string;
  rowCount: number;
  createdAt: number;
}
const downloadStore = new Map<string, StoredDownload>();

function pruneDownloads(): void {
  const now = Date.now();
  for (const [id, entry] of downloadStore.entries()) {
    if (now - entry.createdAt > DOWNLOAD_TTL_MS) downloadStore.delete(id);
  }
  // Hard-cap size in case someone spams: drop oldest entries.
  while (downloadStore.size > DOWNLOAD_STORE_MAX) {
    const oldestKey = downloadStore.keys().next().value;
    if (!oldestKey) break;
    downloadStore.delete(oldestKey);
  }
}

export function takeDownload(id: string): StoredDownload | null {
  pruneDownloads();
  const entry = downloadStore.get(id);
  if (!entry) return null;
  downloadStore.delete(id);
  return entry;
}

function csvField(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Sensible column defaults per source. Users can override via the tool's
// `columns` param, but if they don't we ship a compact, useful set.
const DEFAULT_INBOUND_COLUMNS = [
  "delivery_date", "supplier", "invoice_or_order_number", "item_name",
  "quantity", "unit", "pounds", "line_total", "is_donation", "category", "donor_org"
] as const;

const DEFAULT_OUTBOUND_COLUMNS = [
  "date", "item_name", "quantity", "unit", "category", "program_type", "source"
] as const;

function inboundRowToRecord(r: DeliverySheetRow): Record<string, unknown> {
  const item = (r.item_name_normalized || r.item_name_raw || "").trim();
  return {
    delivery_date: r.delivery_date,
    supplier: r.supplier,
    invoice_or_order_number: r.invoice_or_order_number,
    item_name: item,
    item_name_raw: r.item_name_raw,
    item_name_normalized: r.item_name_normalized,
    quantity: toNumber(r.quantity),
    unit: r.unit,
    pounds: inboundPoundsFor(r),
    approx_weight: r.approx_weight,
    unit_cost: r.unit_cost,
    line_total: r.line_total,
    is_donation: isDonationRow(r),
    is_fee: isFeeRow(r),
    category: r.category,
    donor_org: r.donor_org,
    invoice_date: r.invoice_date,
    row_index: r.rowIndex
  };
}

function outboundRowToRecord(r: EodSheetRow): Record<string, unknown> {
  const item = (r.item_name_normalized || r.item_name_raw || "").trim();
  return {
    date: r.date,
    item_name: item,
    item_name_raw: r.item_name_raw,
    item_name_normalized: r.item_name_normalized,
    quantity: toNumber(r.quantity),
    unit: r.unit,
    category: r.category,
    program_type: r.program_type,
    source: r.source,
    row_index: r.rowIndex
  };
}

function buildCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  const header = columns.map(csvField).join(",");
  const lines = [header];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_inbound",
    description: "Return Inbound Delivery Log rows matching the given filters. Returns at most 100 rows; if the query would exceed that, results are truncated and truncated=true is set. Use this for row-level detail like 'what did Caruso deliver last Thursday'. For aggregates, use get_dashboard_metrics instead — it's cheaper.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)." },
        to: { type: "string", description: "End date YYYY-MM-DD (inclusive)." },
        supplier: { type: "string", description: "Optional supplier slug filter, e.g. 'carusos'." },
        is_donation: { type: "boolean", description: "Optional filter: true → donations only, false → purchases only." },
        include_fees: { type: "boolean", description: "Default false. Set true to include fee/shipping rows (is_fee=true)." },
        item_contains: { type: "string", description: "Optional case-insensitive substring match against item_name." },
        limit: { type: "number", description: "Max rows to return, capped at 100." }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "query_outbound",
    description: "Return Outbound Delivery Log rows matching the given filters. Same 100-row cap as query_inbound. Use for row-level detail on distributions.",
    input_schema: {
      type: "object" as const,
      properties: {
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)." },
        to: { type: "string", description: "End date YYYY-MM-DD (inclusive)." },
        program_type: {
          type: "string",
          description: "Optional filter: home_delivery, in_person_shopping, pre_made_bags, or unknown.",
          enum: ["home_delivery", "in_person_shopping", "pre_made_bags", "unknown"]
        },
        item_contains: { type: "string", description: "Optional case-insensitive substring match." },
        limit: { type: "number", description: "Max rows, capped at 100." }
      },
      required: ["from", "to"]
    }
  },
  {
    name: "create_download",
    description: "Generate a CSV the user can download. Filters the same way as query_inbound / query_outbound but writes ALL matching rows to a CSV (no 100-row cap) — the file lives server-side for 15 minutes, only the download link comes back through the model. Use this whenever the user asks for a CSV, export, spreadsheet, or download.",
    input_schema: {
      type: "object" as const,
      properties: {
        filename: { type: "string", description: "Filename to suggest to the browser, e.g. 'carusos-august-2026.csv'. Must end in .csv." },
        data_source: {
          type: "string",
          description: "Which sheet to export.",
          enum: ["inbound", "outbound"]
        },
        from: { type: "string", description: "Start date YYYY-MM-DD (inclusive)." },
        to: { type: "string", description: "End date YYYY-MM-DD (inclusive)." },
        supplier: { type: "string", description: "(inbound only) Filter by supplier slug." },
        is_donation: { type: "boolean", description: "(inbound only) true → donations only, false → purchases only." },
        include_fees: { type: "boolean", description: "(inbound only) Include is_fee=true rows. Default false." },
        program_type: {
          type: "string",
          description: "(outbound only) Filter by program.",
          enum: ["home_delivery", "in_person_shopping", "pre_made_bags", "unknown"]
        },
        item_contains: { type: "string", description: "Optional case-insensitive substring match on item name." },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Optional column projection. If omitted, defaults to a compact useful set for the chosen data_source. Valid inbound columns: delivery_date, supplier, invoice_or_order_number, item_name, item_name_raw, item_name_normalized, quantity, unit, pounds, approx_weight, unit_cost, line_total, is_donation, is_fee, category, donor_org, invoice_date, row_index. Valid outbound columns: date, item_name, item_name_raw, item_name_normalized, quantity, unit, category, program_type, source, row_index."
        }
      },
      required: ["filename", "data_source", "from", "to"]
    }
  },
  {
    name: "get_dashboard_metrics",
    description: "Return the same aggregated metrics the /dashboard page shows: per-bucket inbound pounds (total / purchased / donated), purchase price, outbound cases (total + per-program), top items, invoice count. This is the fastest way to answer range questions. Prefer this over query_* when the question is about totals or trends.",
    input_schema: {
      type: "object" as const,
      properties: {
        view: {
          type: "string",
          description: "Bucket size: daily (one bucket per day) or weekly (Sun–Sat).",
          enum: ["daily", "weekly"]
        },
        from: { type: "string", description: "Start date YYYY-MM-DD." },
        to: { type: "string", description: "End date YYYY-MM-DD." },
        program: {
          type: "string",
          description: "Optional: restrict outbound aggregates to this program.",
          enum: ["home_delivery", "in_person_shopping", "pre_made_bags"]
        }
      },
      required: ["view", "from", "to"]
    }
  }
];

interface CreatedDownload {
  id: string;
  filename: string;
  row_count: number;
}

interface ToolContext {
  inbound: DeliverySheetRow[];
  outbound: EodSheetRow[];
  createdDownloads: CreatedDownload[];
}

function withinRange(date: string | null, from: string, to: string): boolean {
  if (!date) return false;
  return date >= from && date <= to;
}

function dispatchTool(name: string, input: Record<string, unknown>, ctx: ToolContext): unknown {
  if (name === "query_inbound") {
    const from = String(input.from ?? "");
    const to = String(input.to ?? "");
    const supplier = input.supplier ? String(input.supplier).toLowerCase() : null;
    const isDonation = typeof input.is_donation === "boolean" ? input.is_donation : null;
    const includeFees = input.include_fees === true;
    const itemContains = input.item_contains ? String(input.item_contains).toLowerCase() : null;
    const limit = Math.min(MAX_ROWS_PER_TOOL_RESULT, Math.max(1, Number(input.limit ?? MAX_ROWS_PER_TOOL_RESULT)));

    const filtered = ctx.inbound.filter((r) => {
      if (!withinRange(r.delivery_date, from, to)) return false;
      if (supplier && (r.supplier ?? "").toLowerCase() !== supplier) return false;
      if (isDonation != null && isDonationRow(r) !== isDonation) return false;
      if (!includeFees && isFeeRow(r)) return false;
      if (itemContains) {
        const item = ((r.item_name_normalized || r.item_name_raw) ?? "").toLowerCase();
        if (!item.includes(itemContains)) return false;
      }
      return true;
    });

    const truncated = filtered.length > limit;
    return {
      total_matches: filtered.length,
      returned: Math.min(filtered.length, limit),
      truncated,
      rows: filtered.slice(0, limit).map(slimInbound)
    };
  }

  if (name === "query_outbound") {
    const from = String(input.from ?? "");
    const to = String(input.to ?? "");
    const program = input.program_type ? String(input.program_type) : null;
    const itemContains = input.item_contains ? String(input.item_contains).toLowerCase() : null;
    const limit = Math.min(MAX_ROWS_PER_TOOL_RESULT, Math.max(1, Number(input.limit ?? MAX_ROWS_PER_TOOL_RESULT)));

    const filtered = ctx.outbound.filter((r) => {
      if (!withinRange(r.date, from, to)) return false;
      if (program && (r.program_type ?? "unknown") !== program) return false;
      if (itemContains) {
        const item = ((r.item_name_normalized || r.item_name_raw) ?? "").toLowerCase();
        if (!item.includes(itemContains)) return false;
      }
      return true;
    });

    const truncated = filtered.length > limit;
    return {
      total_matches: filtered.length,
      returned: Math.min(filtered.length, limit),
      truncated,
      rows: filtered.slice(0, limit).map(slimOutbound)
    };
  }

  if (name === "create_download") {
    const rawFilename = String(input.filename ?? "export.csv").trim();
    const filename = rawFilename.toLowerCase().endsWith(".csv") ? rawFilename : rawFilename + ".csv";
    const dataSource = input.data_source === "outbound" ? "outbound" : "inbound";
    const from = String(input.from ?? "");
    const to = String(input.to ?? "");
    const columnsIn = Array.isArray(input.columns) ? (input.columns as unknown[]).map(String) : null;
    const itemContains = input.item_contains ? String(input.item_contains).toLowerCase() : null;

    let records: Array<Record<string, unknown>>;
    let defaultColumns: readonly string[];

    if (dataSource === "inbound") {
      const supplier = input.supplier ? String(input.supplier).toLowerCase() : null;
      const isDonation = typeof input.is_donation === "boolean" ? input.is_donation : null;
      const includeFees = input.include_fees === true;
      const filtered = ctx.inbound.filter((r) => {
        if (!withinRange(r.delivery_date, from, to)) return false;
        if (supplier && (r.supplier ?? "").toLowerCase() !== supplier) return false;
        if (isDonation != null && isDonationRow(r) !== isDonation) return false;
        if (!includeFees && isFeeRow(r)) return false;
        if (itemContains) {
          const item = ((r.item_name_normalized || r.item_name_raw) ?? "").toLowerCase();
          if (!item.includes(itemContains)) return false;
        }
        return true;
      });
      records = filtered.map(inboundRowToRecord);
      defaultColumns = DEFAULT_INBOUND_COLUMNS;
    } else {
      const program = input.program_type ? String(input.program_type) : null;
      const filtered = ctx.outbound.filter((r) => {
        if (!withinRange(r.date, from, to)) return false;
        if (program && (r.program_type ?? "unknown") !== program) return false;
        if (itemContains) {
          const item = ((r.item_name_normalized || r.item_name_raw) ?? "").toLowerCase();
          if (!item.includes(itemContains)) return false;
        }
        return true;
      });
      records = filtered.map(outboundRowToRecord);
      defaultColumns = DEFAULT_OUTBOUND_COLUMNS;
    }

    const columns = columnsIn && columnsIn.length > 0 ? columnsIn : defaultColumns;
    const csv = buildCsv(records, columns);

    const id = randomBytes(12).toString("hex");
    pruneDownloads();
    downloadStore.set(id, { filename, csv, rowCount: records.length, createdAt: Date.now() });
    ctx.createdDownloads.push({ id, filename, row_count: records.length });

    return {
      download_id: id,
      filename,
      row_count: records.length,
      columns,
      note: "The user will see a download link automatically. Tell them what's in the file (row count, date range, filters) — do NOT restate the download_id."
    };
  }

  if (name === "get_dashboard_metrics") {
    const view = (input.view === "weekly" ? "weekly" : "daily") as View;
    const from = String(input.from ?? "");
    const to = String(input.to ?? "");
    const programRaw = input.program ? String(input.program) : null;
    const program: ProgramType | null =
      programRaw === "home_delivery" || programRaw === "in_person_shopping" || programRaw === "pre_made_bags"
        ? programRaw
        : null;

    const spec: WindowSpec = { kind: "custom", from, to };
    const bucketList = resolveBuckets(view, spec);
    const outboundForAgg = program ? ctx.outbound.filter((r) => r.program_type === program) : ctx.outbound;
    const buckets = aggregateDashboard(ctx.inbound, outboundForAgg, view, bucketList);

    // Roll up totals so Claude doesn't have to iterate an array to answer
    // "how much X in this period" — the common case.
    const totals = buckets.reduce(
      (acc, b) => {
        acc.inboundPounds += b.inboundPounds;
        acc.poundsPurchased += b.poundsPurchased;
        acc.poundsDonated += b.poundsDonated;
        acc.purchasePrice += b.purchasePrice;
        acc.outboundCases += b.outboundCases;
        acc.byProgram.home_delivery += b.outboundByProgram.home_delivery;
        acc.byProgram.in_person_shopping += b.outboundByProgram.in_person_shopping;
        acc.byProgram.pre_made_bags += b.outboundByProgram.pre_made_bags;
        acc.byProgram.unknown += b.outboundByProgram.unknown;
        acc.invoiceCount += b.invoiceCount;
        acc.sessionCount += b.sessionCount;
        return acc;
      },
      {
        inboundPounds: 0, poundsPurchased: 0, poundsDonated: 0, purchasePrice: 0,
        outboundCases: 0,
        byProgram: { home_delivery: 0, in_person_shopping: 0, pre_made_bags: 0, unknown: 0 } as Record<ProgramType, number>,
        invoiceCount: 0, sessionCount: 0
      }
    );

    return {
      view, from, to, program,
      totals,
      buckets: buckets.map((b) => ({
        key: b.key,
        start: b.startDate,
        end: b.endDate,
        inbound_pounds: Math.round(b.inboundPounds * 10) / 10,
        pounds_purchased: Math.round(b.poundsPurchased * 10) / 10,
        pounds_donated: Math.round(b.poundsDonated * 10) / 10,
        purchase_price: Math.round(b.purchasePrice * 100) / 100,
        outbound_cases: Math.round(b.outboundCases * 10) / 10,
        outbound_by_program: b.outboundByProgram,
        vendors: b.vendors,
        top_inbound: b.topInbound,
        top_outbound: b.topOutbound,
        invoice_count: b.invoiceCount,
        session_count: b.sessionCount
      }))
    };
  }

  return { error: `Unknown tool: ${name}` };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
}

interface ChatResponseBody {
  ok: boolean;
  reply?: string;
  iterations?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  downloads?: CreatedDownload[];
  error?: string;
}

async function runChatLoop(userMessages: ChatMessage[]): Promise<ChatResponseBody> {
  const [inbound, outbound] = await Promise.all([
    readDeliveryRows({ limit: 20000 }),
    readEodRows({ limit: 20000 })
  ]);
  const ctx: ToolContext = { inbound, outbound, createdDownloads: [] };

  const history: Anthropic.MessageParam[] = userMessages.map((m) => ({
    role: m.role,
    content: m.content
  }));

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1500,
      system: buildSystemPrompt(),
      tools: CHAT_TOOLS,
      messages: history
    });

    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    cacheCreation += response.usage.cache_creation_input_tokens ?? 0;
    cacheRead += response.usage.cache_read_input_tokens ?? 0;

    if (response.stop_reason === "end_turn" || response.stop_reason === "max_tokens") {
      const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
      return {
        ok: true,
        reply: textBlock?.text ?? "(no response)",
        iterations: i + 1,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreation,
          cache_read_input_tokens: cacheRead
        },
        downloads: ctx.createdDownloads.length > 0 ? ctx.createdDownloads : undefined
      };
    }

    if (response.stop_reason === "tool_use") {
      history.push({ role: "assistant", content: response.content });
      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUseBlocks) {
        try {
          const result = dispatchTool(tu.name, tu.input as Record<string, unknown>, ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result)
          });
        } catch (err) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: (err as Error).message }),
            is_error: true
          });
        }
      }
      history.push({ role: "user", content: toolResults });
      continue;
    }

    return {
      ok: false,
      error: `Unexpected stop_reason: ${response.stop_reason}`,
      iterations: i + 1
    };
  }

  return {
    ok: false,
    error: `Chat exceeded ${MAX_ITERATIONS} tool iterations without finishing. Try a more specific question.`,
    iterations: MAX_ITERATIONS
  };
}

async function readJsonBody<T>(req: IncomingMessage, maxBytes = 512 * 1024): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    total += b.length;
    if (total > maxBytes) throw new Error(`Payload too large (${total} > ${maxBytes})`);
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export function handleChatDownloadRequest(req: IncomingMessage, res: ServerResponse, id: string): void {
  const entry = takeDownload(id);
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Download link expired or not found. Ask the chat to regenerate it.");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${entry.filename.replace(/"/g, "")}"`,
    "Cache-Control": "no-store"
  });
  res.end(entry.csv);
}

export async function handleChatApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: ChatRequestBody;
  try {
    body = await readJsonBody<ChatRequestBody>(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
    return;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "messages must be a non-empty array" }));
    return;
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === "user");
  if (!lastUser || !lastUser.content.trim()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no user message" }));
    return;
  }

  try {
    const result = await runChatLoop(body.messages);
    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error("[chat] loop failed:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: (err as Error).message ?? "internal error" }));
  }
}

// Chat lives as an embedded panel on /dashboard (see dashboard.ts).
// These three exports are the panel's building blocks so dashboard.ts can
// interpolate them into its own HTML without duplicating the fetch loop.

export const CHAT_PANEL_CSS = `
.layout { display: flex; gap: 20px; align-items: flex-start; }
.dashboard-main { flex: 1 1 auto; min-width: 0; }
.chat-panel { display: none; flex-direction: column; width: 380px; flex-shrink: 0; background: var(--card); border: 1px solid var(--line); border-radius: var(--radius-md, 12px); padding: 14px; height: calc(100vh - 64px); position: sticky; top: 32px; align-self: flex-start; }
body[data-chat-open="true"] .chat-panel { display: flex; }
.chat-panel .chat-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.chat-panel .chat-head h3 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.chat-panel .chat-head .actions { display: flex; gap: 6px; }
.chat-panel .chat-meta { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
.chat-panel .examples { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px; }
.chat-panel .example { font-size: 11px; color: var(--muted); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; cursor: pointer; }
.chat-panel .example:hover { background: #fafbfc; color: var(--ink); }
.chat-panel .messages { flex: 1; display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; overflow-y: auto; min-height: 0; padding-right: 4px; }
.chat-panel .msg { padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
.chat-panel .msg.user { background: #eef2ff; align-self: flex-end; max-width: 88%; }
.chat-panel .msg.assistant { background: #fafbfc; border: 1px solid var(--line); align-self: flex-start; max-width: 95%; }
.chat-panel .msg.assistant.thinking { color: var(--muted); font-style: italic; }
.chat-panel .msg.error { background: #fee2e2; color: #7f1d1d; border: 1px solid #fecaca; align-self: flex-start; max-width: 95%; }
.chat-panel .msg .stats { color: var(--muted); font-size: 10px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.chat-panel .msg .downloads { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
.chat-panel .msg .downloads a { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: white; border: 1px solid var(--line); border-radius: 8px; font-size: 12px; color: var(--ink); text-decoration: none; font-weight: 500; }
.chat-panel .msg .downloads a:hover { background: #fafbfc; border-color: var(--ink, #0a2540); }
.chat-panel .msg .downloads .rows { color: var(--muted); font-weight: 400; }
.chat-panel .composer { display: flex; gap: 6px; align-items: flex-end; background: white; border: 1px solid var(--line); border-radius: 10px; padding: 6px; }
.chat-panel textarea { flex: 1; border: none; outline: none; font-family: inherit; font-size: 13px; resize: none; min-height: 20px; max-height: 120px; padding: 4px; color: var(--ink); background: transparent; }
.chat-panel .hint { color: var(--muted); font-size: 11px; margin-top: 6px; }
.chat-panel .btn-mini { padding: 4px 8px; font-size: 11px; }
.chat-panel .btn-primary { background: var(--ink, #0a2540); color: white; border-color: var(--ink, #0a2540); }
.chat-panel .btn-primary:disabled { opacity: .5; cursor: wait; }
@media (max-width: 1200px) {
  .chat-panel { position: fixed; top: 0; right: 0; bottom: 0; height: 100vh; width: min(400px, 92vw); z-index: 100; border-radius: 0; box-shadow: -6px 0 16px rgba(0,0,0,0.08); }
}
`;

export function chatPanelHtml(tenantShort: string): string {
  return `
<aside class="chat-panel" id="chat-panel">
  <div class="chat-head">
    <h3>${tenantShort} · Chat</h3>
    <div class="actions">
      <button class="btn btn-mini" id="chat-clear-btn" type="button">Clear</button>
      <button class="btn btn-mini" id="chat-close-btn" type="button" aria-label="Close chat">✕</button>
    </div>
  </div>
  <div class="chat-meta">Ask questions about your inbound and outbound inventory. Read-only.</div>
  <div class="examples" id="chat-examples">
    <span class="example">Pounds we got last week?</span>
    <span class="example">Biggest supplier in August?</span>
    <span class="example">How much did we spend last month?</span>
    <span class="example">CSV of Caruso invoices in August</span>
    <span class="example">Export outbound rows for last week</span>
  </div>
  <div class="messages" id="chat-messages"></div>
  <div class="composer">
    <textarea id="chat-input" rows="1" placeholder="Ask about inventory…"></textarea>
    <button class="btn btn-mini btn-primary" id="chat-send-btn" type="button">Send</button>
  </div>
  <div class="hint">Enter to send · Shift+Enter for a new line</div>
</aside>`;
}

export const CHAT_PANEL_JS = `
(function(){
  var history = [];
  var messagesEl = document.getElementById('chat-messages');
  var input = document.getElementById('chat-input');
  var sendBtn = document.getElementById('chat-send-btn');
  var clearBtn = document.getElementById('chat-clear-btn');
  var closeBtn = document.getElementById('chat-close-btn');
  var toggleBtn = document.getElementById('chat-toggle-btn');
  var examplesEl = document.getElementById('chat-examples');
  if (!messagesEl || !input || !sendBtn) return;

  function esc(s) { return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

  function setOpen(open) {
    document.body.setAttribute('data-chat-open', open ? 'true' : 'false');
    try { localStorage.setItem('loadslip.chat.open', open ? '1' : '0'); } catch(e){}
    if (open) setTimeout(function(){ input.focus(); }, 50);
  }

  function renderMessage(role, text, opts) {
    var div = document.createElement('div');
    div.className = 'msg ' + role + (opts && opts.thinking ? ' thinking' : '') + (opts && opts.error ? ' error' : '');
    div.innerHTML = esc(text);
    if (opts && opts.downloads && opts.downloads.length) {
      var d = document.createElement('div');
      d.className = 'downloads';
      for (var i = 0; i < opts.downloads.length; i++) {
        var dl = opts.downloads[i];
        var a = document.createElement('a');
        a.href = '/api/chat/download/' + encodeURIComponent(dl.id);
        a.setAttribute('download', dl.filename);
        a.innerHTML = '⬇ ' + esc(dl.filename) + ' <span class="rows">(' + dl.row_count + ' rows)</span>';
        d.appendChild(a);
      }
      div.appendChild(d);
    }
    if (opts && opts.stats) {
      var s = document.createElement('div');
      s.className = 'stats';
      s.textContent = opts.stats;
      div.appendChild(s);
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  if (examplesEl) examplesEl.addEventListener('click', function(e){
    if (e.target && e.target.classList && e.target.classList.contains('example')) {
      input.value = e.target.textContent;
      autoGrow();
      input.focus();
    }
  });

  if (clearBtn) clearBtn.addEventListener('click', function(){
    history.length = 0;
    messagesEl.innerHTML = '';
  });

  if (closeBtn) closeBtn.addEventListener('click', function(){ setOpen(false); });
  if (toggleBtn) toggleBtn.addEventListener('click', function(e){
    e.preventDefault();
    var open = document.body.getAttribute('data-chat-open') === 'true';
    setOpen(!open);
  });

  async function send() {
    var text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    input.value = '';
    autoGrow();
    history.push({ role: 'user', content: text });
    renderMessage('user', text);
    var thinking = renderMessage('assistant', 'Thinking…', { thinking: true });
    sendBtn.disabled = true;
    try {
      var res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      });
      var body = await res.json();
      thinking.remove();
      if (!body.ok) {
        renderMessage('assistant', body.error || 'Something went wrong.', { error: true });
        history.pop();
      } else {
        history.push({ role: 'assistant', content: body.reply });
        var u = body.usage || {};
        var stats = 'iterations ' + (body.iterations || 1) +
          ' · input ' + (u.input_tokens || 0) +
          ' · output ' + (u.output_tokens || 0) +
          (u.cache_read_input_tokens ? ' · cache-hit ' + u.cache_read_input_tokens : '');
        renderMessage('assistant', body.reply, { stats: stats, downloads: body.downloads });
      }
    } catch (err) {
      thinking.remove();
      renderMessage('assistant', 'Network error: ' + (err.message || err), { error: true });
      history.pop();
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  }
  sendBtn.addEventListener('click', send);

  // Restore panel state on load.
  try {
    var saved = localStorage.getItem('loadslip.chat.open');
    if (saved === '1') setOpen(true);
  } catch(e){}
})();
`;
