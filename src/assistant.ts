import Anthropic from "@anthropic-ai/sdk";
import { env } from "./config.js";
import { readEodRows, readDeliveryRows } from "./sheets.js";
import type { ConversationMessage, ConversationContentBlock, PendingAssistantCorrection, CorrectionSheet } from "./types.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const ASSISTANT_SYSTEM_PROMPT = `You are a helpful inventory assistant for Rainier Valley Food Bank.
Today's date is ${new Date().toISOString().slice(0, 10)}.

There are TWO separate Google Sheets tabs you can query:

1. **EOD Inventory** (use read_eod_inventory): End-of-day counts recorded by staff walking the floor. Use this when someone asks what's currently on hand, what was logged at end of day, or how much of something is left. Fields include: date, item_name_normalized, quantity, unit, category.

2. **Delivery Log** (use read_delivery_log): Incoming deliveries from suppliers (Caruso's, Charlie's, Northwest Harvest, Pacific). Use this when someone asks about a delivery, a supplier invoice, or what was received from a vendor. Fields include: delivery_date, supplier, item_name_normalized, quantity, unit.

Always pick the right sheet based on context. If unsure, try EOD Inventory first for general stock questions.

Guidelines:
- When proposing a correction, clearly state what you are changing and why.
- Never modify data without the user's explicit confirmation — corrections require a 👍 reaction.
- If a read returns no results, try the other sheet before giving up.
- Always convert dates to YYYY-MM-DD before querying. If the user says "2/11" or "Feb 11" with no year, assume the current year unless context suggests otherwise.
- Be concise. Summarize long results rather than listing every row.`;

const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "read_eod_inventory",
    description: "Read EOD Inventory rows from Google Sheets, optionally filtered by date.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Filter by date in YYYY-MM-DD format. Omit to return recent rows." },
        limit: { type: "number", description: "Maximum rows to return. Default 50." }
      },
      required: []
    }
  },
  {
    name: "read_delivery_log",
    description: "Read Delivery Log rows from Google Sheets, optionally filtered by date and/or supplier.",
    input_schema: {
      type: "object" as const,
      properties: {
        date: { type: "string", description: "Filter by delivery_date in YYYY-MM-DD format." },
        supplier: { type: "string", description: "Filter by supplier. Valid values: carusos, charlies, nw_harvest, pacific, unknown." },
        limit: { type: "number", description: "Maximum rows to return. Default 50." }
      },
      required: []
    }
  },
  {
    name: "propose_eod_correction",
    description: "Propose a correction to a field in an EOD Inventory row. Does NOT write immediately — posts a confirmation to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        row_index: { type: "number", description: "The rowIndex from the read_eod_inventory result (1-based sheet row)." },
        column_name: { type: "string", description: "Column to correct. Valid values: date, item_name_raw, item_name_normalized, quantity, quantity_raw, unit, category, notes, confidence, source." },
        old_value: { type: "string", description: "The current value in that field (from the read result), for the confirmation message." },
        new_value: { type: "string", description: "The corrected value." },
        reason: { type: "string", description: "Brief explanation of why this correction is needed." }
      },
      required: ["row_index", "column_name", "new_value", "reason"]
    }
  },
  {
    name: "propose_delivery_correction",
    description: "Propose a correction to a field in a Delivery Log row. Does NOT write immediately — posts a confirmation to the user.",
    input_schema: {
      type: "object" as const,
      properties: {
        row_index: { type: "number", description: "The rowIndex from the read_delivery_log result (1-based sheet row)." },
        column_name: { type: "string", description: "Column to correct. Valid values: supplier, document_type, delivery_date, invoice_or_order_number, destination_org, item_name_raw, item_name_normalized, quantity, quantity_raw, unit, pack_size_raw, category, unit_cost, line_total, notes." },
        old_value: { type: "string", description: "The current value in that field (from the read result), for the confirmation message." },
        new_value: { type: "string", description: "The corrected value." },
        reason: { type: "string", description: "Brief explanation of why this correction is needed." }
      },
      required: ["row_index", "column_name", "new_value", "reason"]
    }
  }
];

function buildCorrectionSummary(correction: PendingAssistantCorrection): string {
  const sheetName = correction.sheet === "eod" ? "EOD Inventory" : "Delivery Log";
  return (
    `📝 *Proposed correction*\n` +
    `Sheet: ${sheetName}\n` +
    `Row: ${correction.rowIndex}\n` +
    `Field: \`${correction.columnName}\`\n` +
    (correction.oldValue != null ? `Current value: \`${correction.oldValue}\`\n` : "") +
    `New value: \`${correction.newValue}\`\n` +
    `Reason: ${correction.reason ?? "Not specified"}\n\n` +
    `React 👍 to apply · React ❌ to discard`
  );
}

export async function runAssistantLoop(params: {
  history: ConversationMessage[];
  channel: string;
  threadTs: string;
  requestedBy: string;
  onCorrectionProposed: (correction: PendingAssistantCorrection, summaryText: string) => Promise<{ messageTs: string }>;
}): Promise<{ responseText: string; corrections: PendingAssistantCorrection[] }> {
  const { history, channel, threadTs, requestedBy, onCorrectionProposed } = params;
  const corrections: PendingAssistantCorrection[] = [];
  const maxIterations = env.ASSISTANT_MAX_TOOL_ITERATIONS;

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: ASSISTANT_SYSTEM_PROMPT,
      tools: ASSISTANT_TOOLS,
      messages: history as Anthropic.MessageParam[]
    });

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find((b) => b.type === "text");
      return { responseText: textBlock?.type === "text" ? textBlock.text : "(no response)", corrections };
    }

    if (response.stop_reason === "tool_use") {
      const assistantBlocks: ConversationContentBlock[] = response.content.map((b) => {
        if (b.type === "text") return { type: "text" as const, text: b.text };
        if (b.type === "tool_use") return { type: "tool_use" as const, id: b.id, name: b.name, input: b.input as Record<string, unknown> };
        throw new Error(`Unexpected block type: ${b.type}`);
      });
      history.push({ role: "assistant", content: assistantBlocks });

      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      for (const toolUse of toolUseBlocks) {
        const { resultText, correction } = await dispatchTool({ toolUse, channel, threadTs, requestedBy, onCorrectionProposed });
        if (correction) corrections.push(correction);
        history.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: resultText }]
        });
      }
      continue;
    }

    throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
  }

  return { responseText: "I wasn't able to complete the request within the allowed steps. Please try a more specific question.", corrections };
}

async function dispatchTool(params: {
  toolUse: Anthropic.ToolUseBlock;
  channel: string;
  threadTs: string;
  requestedBy: string;
  onCorrectionProposed: (correction: PendingAssistantCorrection, summaryText: string) => Promise<{ messageTs: string }>;
}): Promise<{ resultText: string; correction?: PendingAssistantCorrection }> {
  const { toolUse, channel, threadTs, requestedBy, onCorrectionProposed } = params;
  const input = toolUse.input as Record<string, unknown>;

  if (toolUse.name === "read_eod_inventory") {
    const rows = await readEodRows({ date: input.date as string | undefined, limit: input.limit as number | undefined });
    return { resultText: rows.length ? JSON.stringify(rows) : "No EOD inventory rows found for the given filters." };
  }

  if (toolUse.name === "read_delivery_log") {
    const rows = await readDeliveryRows({ date: input.date as string | undefined, supplier: input.supplier as string | undefined, limit: input.limit as number | undefined });
    return { resultText: rows.length ? JSON.stringify(rows) : "No delivery log rows found for the given filters." };
  }

  if (toolUse.name === "propose_eod_correction" || toolUse.name === "propose_delivery_correction") {
    const sheet: CorrectionSheet = toolUse.name === "propose_eod_correction" ? "eod" : "delivery";
    const correction: PendingAssistantCorrection = {
      correctionId: Math.random().toString(36).slice(2),
      channel,
      threadTs,
      summaryMessageTs: "",
      sheet,
      rowIndex: input.row_index as number,
      columnName: input.column_name as string,
      oldValue: (input.old_value as string) ?? null,
      newValue: input.new_value as string,
      reason: input.reason as string,
      requestedBy,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000
    };
    const summaryText = buildCorrectionSummary(correction);
    const { messageTs } = await onCorrectionProposed(correction, summaryText);
    correction.summaryMessageTs = messageTs;
    return { resultText: "Correction proposed. Awaiting user 👍/❌ confirmation.", correction };
  }

  return { resultText: `Unknown tool: ${toolUse.name}` };
}
