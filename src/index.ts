import { createHash } from "crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import axios from "axios";
import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { env } from "./config.js";
import { appendExtractionRows, ensureSheetHeader, appendEodRows, ensureEodSheetHeader, updateSheetCell, readDeliveryRows, readEodRows } from "./sheets.js";
import { buildDashboardHtml } from "./dashboard.js";
import {
  extractFromImage,
  extractFromText,
  transcribeAudio,
  guessSupplierFromFilename,
  classifyImage,
  extractFromWhiteboard
} from "./extraction.js";
import { runAssistantLoop } from "./assistant.js";
import type { ExtractionResult, EodExtractionResult, Supplier, ThreadHistory, PendingAssistantCorrection } from "./types.js";

interface ProcessedFileExtraction {
  fileId: string;
  contentHash: string;
  fileName: string;
  photoUrl: string;
  extraction: ExtractionResult;
}

interface ProcessedWhiteboardFile {
  fileId: string;
  contentHash: string;
  fileName: string;
  photoUrl: string;
  extraction: EodExtractionResult;
}

const CONFIDENCE_THRESHOLD = 0.7;

function slackTsToLocalDate(ts: string): string {
  const seconds = Number(ts.split(".")[0]);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(seconds * 1000));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

const processedFileIds = new Set<string>();
const processedContentHashes = new Set<string>();
const processedInvoiceKeys = new Set<string>();
const processedMessageKeys = new Set<string>();

interface PendingEodEntry {
  channel: string;
  messageTs: string;
  recordedBy: string;
  extraction: EodExtractionResult;
  source: "text" | "voice";
  expiresAt: number;
}

const EOD_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const ASSISTANT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const pendingEodEntries = new Map<string, PendingEodEntry>();
const threadHistories = new Map<string, ThreadHistory>();
const pendingAssistantCorrections = new Map<string, PendingAssistantCorrection>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pendingEodEntries.entries()) {
    if (entry.expiresAt < now) pendingEodEntries.delete(key);
  }
  for (const [key, h] of threadHistories.entries()) {
    if (h.lastActivityAt + ASSISTANT_TTL_MS < now) threadHistories.delete(key);
  }
  for (const [key, c] of pendingAssistantCorrections.entries()) {
    if (c.expiresAt < now) pendingAssistantCorrections.delete(key);
  }
}, 30 * 60 * 1000);

function guessSupplierFromText(text: string): Supplier {
  const t = (text || "").toLowerCase();
  if (t.includes("caruso")) return "carusos";
  if (t.includes("charlie")) return "charlies";
  if (t.includes("northwest harvest") || t.includes("nw harvest") || t.includes("food lifeline")) return "nw_harvest";
  if (t.includes("pacific") || t.includes("pfd")) return "pacific";
  return "unknown";
}

function isMime(prefix: string, mimeType?: string): boolean {
  return (mimeType ?? "").startsWith(prefix);
}

function isEodMessage(text?: string): boolean {
  return /^eod:?\s/i.test((text || "").trimStart());
}

function stripEodPrefix(text: string): string {
  return text.replace(/^eod:?\s*/i, "").trim();
}

function formatEodSummary(extraction: EodExtractionResult): string {
  const lines = extraction.line_items.map((item) => {
    const qty = item.quantity_raw ?? item.quantity ?? "?";
    const unit = item.unit ? ` ${item.unit}(s)` : "";
    const name = item.item_name_normalized ?? item.item_name_raw ?? "Unknown item";
    const conf = Math.round(item.confidence * 100);
    return `• ${qty}${unit} ${name} (${conf}% confidence)`;
  });

  const warnings = extraction.source_warnings.length
    ? `\n⚠️ Warnings: ${extraction.source_warnings.join(", ")}`
    : "";

  return (
    `📋 *Outbound Delivery Log — ${extraction.date ?? "today"}*\n` +
    `${lines.join("\n")}\n\n` +
    `React 👍 to save to Google Sheets\nReact ❌ to discard` +
    warnings
  );
}

function pendingKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function summarizeFiles(files: ProcessedFileExtraction[]): {
  lineItems: number;
  fees: number;
  avgConfidence: number;
} {
  let lineItems = 0;
  let fees = 0;
  let totalConfidence = 0;
  for (const f of files) {
    lineItems += f.extraction.line_items.length;
    fees += f.extraction.fees.length;
    for (const li of f.extraction.line_items) {
      totalConfidence += li.confidence;
    }
  }
  const avgConfidence = lineItems > 0 ? totalConfidence / lineItems : 0;
  return { lineItems, fees, avgConfidence };
}

function padRight(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return " ".repeat(width - s.length) + s;
}

function summarizeWhiteboardFiles(files: ProcessedWhiteboardFile[]): {
  lineItems: number;
  avgConfidence: number;
} {
  let lineItems = 0;
  let totalConfidence = 0;
  for (const f of files) {
    lineItems += f.extraction.line_items.length;
    for (const li of f.extraction.line_items) {
      totalConfidence += li.confidence;
    }
  }
  const avgConfidence = lineItems > 0 ? totalConfidence / lineItems : 0;
  return { lineItems, avgConfidence };
}

function formatWhiteboardTable(files: ProcessedWhiteboardFile[]): string {
  const NAME_W = 32;
  const QTY_W = 8;
  const CONF_W = 5;
  const header = `${padRight("Item", NAME_W)} ${padLeft("Qty", QTY_W)} ${padLeft("Conf", CONF_W)}`;
  const sep = "─".repeat(NAME_W + QTY_W + CONF_W + 2);

  const sections: string[] = [];
  for (const f of files) {
    const rows = f.extraction.line_items.map((li) => {
      const name = li.item_name_normalized ?? li.item_name_raw ?? "Unknown";
      const qty = li.quantity != null ? String(li.quantity) : (li.quantity_raw ?? "?");
      const conf = `${Math.round(li.confidence * 100)}%`;
      return `${padRight(name, NAME_W)} ${padLeft(qty, QTY_W)} ${padLeft(conf, CONF_W)}`;
    });
    const dateLabel = f.extraction.date ? ` — ${f.extraction.date}` : "";
    const body = [header, sep, ...rows].join("\n");
    sections.push(`*${f.fileName}${dateLabel}*\n\`\`\`\n${body}\n\`\`\``);
  }
  return sections.join("\n\n");
}

function formatExtractionTable(files: ProcessedFileExtraction[]): string {
  const NAME_W = 32;
  const QTY_W = 8;
  const CONF_W = 5;
  const header = `${padRight("Item", NAME_W)} ${padLeft("Qty", QTY_W)} ${padLeft("Conf", CONF_W)}`;
  const sep = "─".repeat(NAME_W + QTY_W + CONF_W + 2);

  const sections: string[] = [];
  for (const f of files) {
    const rows = f.extraction.line_items.map((li) => {
      const name = li.item_name_normalized ?? li.item_name_raw ?? "Unknown";
      const qty = li.quantity_raw ?? (li.quantity != null ? String(li.quantity) : "?");
      const conf = `${Math.round(li.confidence * 100)}%`;
      return `${padRight(name, NAME_W)} ${padLeft(qty, QTY_W)} ${padLeft(conf, CONF_W)}`;
    });
    const feeRows = f.extraction.fees.map((fee) => {
      const name = `(fee) ${fee.description}`;
      const amount = `$${fee.amount.toFixed(2)}`;
      return `${padRight(name, NAME_W)} ${padLeft(amount, QTY_W)} ${padLeft("", CONF_W)}`;
    });
    const body = [header, sep, ...rows, ...feeRows].join("\n");
    sections.push(`*${f.fileName}*\n\`\`\`\n${body}\n\`\`\``);
  }
  return sections.join("\n\n");
}

async function downloadSlackFile(url: string): Promise<Buffer> {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` }
  });
  return Buffer.from(res.data);
}

const app = new App({
  token: env.SLACK_BOT_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  socketMode: Boolean(env.SLACK_APP_TOKEN),
  appToken: env.SLACK_APP_TOKEN
});

async function processInvoiceBatch(params: {
  processedFiles: ProcessedFileExtraction[];
  channel: string;
  messageTs: string;
  messageKey: string;
  uploadedBy: string;
  client: WebClient;
}): Promise<void> {
  const { processedFiles, channel, messageTs, messageKey, uploadedBy, client } = params;
  const summary = summarizeFiles(processedFiles);
  const confidencePct = Math.round(summary.avgConfidence * 100);
  const confidenceEmoji = summary.avgConfidence >= 0.9 ? "🟢" : summary.avgConfidence >= 0.75 ? "🟡" : "🔴";
  const tableText = formatExtractionTable(processedFiles);
  const headerLine =
    `📦 *Inbound Extraction* — Files: *${processedFiles.length}* | Line items: *${summary.lineItems}* | Fees: *${summary.fees}*\n` +
    `${confidenceEmoji} Avg confidence: *${confidencePct}%*`;

  if (summary.avgConfidence < CONFIDENCE_THRESHOLD) {
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text:
        `${headerLine}\n\n${tableText}\n\n` +
        `❌ *Confidence too low* (${confidencePct}% < ${Math.round(CONFIDENCE_THRESHOLD * 100)}%). ` +
        `The photo wasn't clear enough — please retake (good lighting, flat page, full document in frame) and try again. Nothing was logged.`
    });
    return;
  }

  try {
    await ensureSheetHeader();
    let totalRows = 0;
    for (const file of processedFiles) {
      const rowsAdded = await appendExtractionRows({
        extraction: file.extraction,
        photoUrl: file.photoUrl,
        slackChannel: channel,
        slackMessageTs: messageTs,
        uploadedBy
      });
      totalRows += rowsAdded;
    }

    for (const file of processedFiles) {
      processedFileIds.add(file.fileId);
      processedContentHashes.add(file.contentHash);
      if (file.extraction.invoice_or_order_number && file.extraction.supplier !== "unknown") {
        processedInvoiceKeys.add(`${file.extraction.supplier}:${file.extraction.invoice_or_order_number}`);
      }
    }
    processedMessageKeys.add(messageKey);

    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${headerLine}\n\n${tableText}\n\n✅ *Logged ${totalRows} row(s) to Google Sheets.*`
    });
  } catch (sheetsError) {
    console.error("Google Sheets error:", sheetsError);
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${headerLine}\n\n${tableText}\n\n❌ Error writing to Google Sheets: ${(sheetsError as Error).message}`
    });
  }
}

async function processWhiteboardBatch(params: {
  whiteboardFiles: ProcessedWhiteboardFile[];
  channel: string;
  messageTs: string;
  messageKey: string;
  uploadedBy: string;
  client: WebClient;
}): Promise<void> {
  const { whiteboardFiles, channel, messageTs, messageKey, uploadedBy, client } = params;
  const summary = summarizeWhiteboardFiles(whiteboardFiles);
  const confidencePct = Math.round(summary.avgConfidence * 100);
  const confidenceEmoji = summary.avgConfidence >= 0.9 ? "🟢" : summary.avgConfidence >= 0.75 ? "🟡" : "🔴";
  const tableText = formatWhiteboardTable(whiteboardFiles);
  const headerLine =
    `📋 *Outbound Whiteboard* — Files: *${whiteboardFiles.length}* | Line items: *${summary.lineItems}*\n` +
    `${confidenceEmoji} Avg confidence: *${confidencePct}%*`;

  if (summary.avgConfidence < CONFIDENCE_THRESHOLD) {
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text:
        `${headerLine}\n\n${tableText}\n\n` +
        `❌ *Confidence too low* (${confidencePct}% < ${Math.round(CONFIDENCE_THRESHOLD * 100)}%). ` +
        `The whiteboard photo wasn't clear enough — please retake (good lighting, full board in frame, no glare on tally marks) and try again. Nothing was logged.`
    });
    return;
  }

  try {
    await ensureEodSheetHeader();
    let totalRows = 0;
    for (const file of whiteboardFiles) {
      const rowsAdded = await appendEodRows({
        extraction: file.extraction,
        source: "whiteboard",
        slackChannel: channel,
        slackMessageTs: messageTs,
        recordedBy: uploadedBy
      });
      totalRows += rowsAdded;
    }

    for (const file of whiteboardFiles) {
      processedFileIds.add(file.fileId);
      processedContentHashes.add(file.contentHash);
    }
    processedMessageKeys.add(messageKey);

    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${headerLine}\n\n${tableText}\n\n✅ *Logged ${totalRows} row(s) to Outbound Delivery Log sheet.*`
    });
  } catch (sheetsError) {
    console.error("Google Sheets error:", sheetsError);
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${headerLine}\n\n${tableText}\n\n❌ Error writing to Google Sheets: ${(sheetsError as Error).message}`
    });
  }
}

app.event("message", async ({ event, client, logger }) => {
  try {
    console.log("Received message event:", JSON.stringify(event, null, 2));
    if ((event as { subtype?: string }).subtype !== "file_share") {
      console.log("Skipping - not a file_share event");
      return;
    }

    const message = event as {
      channel: string;
      ts: string;
      user?: string;
      text?: string;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private_download?: string;
      }>;
    };

    if (env.INVENTORY_CHANNEL_ID && message.channel !== env.INVENTORY_CHANNEL_ID) {
      return;
    }

    const messageKey = pendingKey(message.channel, message.ts);
    if (processedMessageKeys.has(messageKey)) {
      console.log(`Skipping duplicate message: ${messageKey}`);
      return;
    }

    const allFiles = (message.files || []).filter((f) => isMime("image/", f.mimetype) && f.url_private_download);
    if (!allFiles.length) return;

    const files = allFiles.filter((f) => !processedFileIds.has(f.id));
    if (!files.length) {
      console.log(`All ${allFiles.length} file(s) already processed, skipping`);
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `⚠️ This delivery has already been processed. Skipping duplicate upload.`
      });
      return;
    }

    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Received ${files.length} file(s). Starting extraction...`
    });

    const processedFiles: ProcessedFileExtraction[] = [];
    const whiteboardFiles: ProcessedWhiteboardFile[] = [];
    const uploadedBy = message.user || "unknown";

    for (const file of files) {
      if (!file.url_private_download) continue;

      const buffer = await downloadSlackFile(file.url_private_download);
      const contentHash = createHash("sha256").update(buffer).digest("hex");

      if (processedContentHashes.has(contentHash)) {
        console.log(`Skipping file ${file.name} — content already processed (hash: ${contentHash.slice(0, 12)}…)`);
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: `⚠️ *${file.name}* appears to be a duplicate (same file content already processed). Skipping.`
        });
        continue;
      }

      const kind = await classifyImage({ imageBytes: buffer, mimeType: file.mimetype });
      console.log(`Classified ${file.name} as: ${kind}`);

      if (kind === "whiteboard") {
        const wbExtraction = await extractFromWhiteboard({
          imageBytes: buffer,
          mimeType: file.mimetype,
          filename: file.name
        });
        whiteboardFiles.push({
          fileId: file.id,
          contentHash,
          fileName: file.name,
          photoUrl: file.url_private_download,
          extraction: wbExtraction
        });
        continue;
      }

      const supplierHint = guessSupplierFromText(message.text || "") !== "unknown"
        ? guessSupplierFromText(message.text || "")
        : guessSupplierFromFilename(file.name || "");

      const extraction = await extractFromImage({
        imageBytes: buffer,
        mimeType: file.mimetype,
        filename: file.name,
        supplierHint
      });

      if (!extraction.delivery_date) {
        extraction.delivery_date = slackTsToLocalDate(message.ts);
        extraction.source_warnings.push(
          `delivery_date not found on document — defaulted to upload date (${extraction.delivery_date})`
        );
      }

      if (extraction.invoice_or_order_number && extraction.supplier !== "unknown") {
        const invoiceKey = `${extraction.supplier}:${extraction.invoice_or_order_number}`;
        if (processedInvoiceKeys.has(invoiceKey)) {
          console.log(`Skipping file ${file.name} — invoice already processed (${invoiceKey})`);
          await client.chat.postMessage({
            channel: message.channel,
            thread_ts: message.ts,
            text: `⚠️ Invoice *${extraction.invoice_or_order_number}* from *${extraction.supplier}* has already been processed. Skipping duplicate.`
          });
          continue;
        }
      }

      processedFiles.push({
        fileId: file.id,
        contentHash,
        fileName: file.name,
        photoUrl: file.url_private_download,
        extraction
      });
    }

    if (!processedFiles.length && !whiteboardFiles.length) {
      console.log("All files were duplicates, skipping");
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `⚠️ All files in this upload were already processed. Nothing new to extract.`
      });
      return;
    }

    if (processedFiles.length) {
      await processInvoiceBatch({
        processedFiles,
        channel: message.channel,
        messageTs: message.ts,
        messageKey,
        uploadedBy,
        client
      });
    }

    if (whiteboardFiles.length) {
      await processWhiteboardBatch({
        whiteboardFiles,
        channel: message.channel,
        messageTs: message.ts,
        messageKey,
        uploadedBy,
        client
      });
    }
  } catch (error) {
    logger.error(error);
    const e = error as Error;
    const message = "Inventory processing failed. Check app logs for details.";
    try {
      const evt = event as { channel?: string; ts?: string };
      if (evt.channel && evt.ts) {
        await client.chat.postMessage({ channel: evt.channel, thread_ts: evt.ts, text: message });
      }
    } catch {
      logger.error("Failed to send Slack error message");
    }
    logger.error(`Pipeline error: ${e.message}`);
  }
});

app.event("reaction_added", async ({ event, client, logger }) => {
  try {
    console.log("Reaction event received:", JSON.stringify(event, null, 2));
    if (event.item.type !== "message") return;
    const channel = event.item.channel;
    const ts = event.item.ts;
    const reaction = event.reaction;

    console.log(`Reaction: ${reaction}, Channel: ${channel}, TS: ${ts}`);
    const lookupKey = pendingKey(channel, ts);

    // ── Assistant correction reaction handling ─────────────────────────────
    const pendingCorrection = pendingAssistantCorrections.get(lookupKey);
    if (pendingCorrection) {
      if (reaction === "+1") {
        pendingAssistantCorrections.delete(lookupKey);
        try {
          await updateSheetCell({
            worksheetName: pendingCorrection.sheet === "eod" ? env.EOD_WORKSHEET_NAME : env.GOOGLE_WORKSHEET_NAME,
            rowIndex: pendingCorrection.rowIndex,
            columnName: pendingCorrection.columnName,
            newValue: pendingCorrection.newValue
          });
          await client.chat.postMessage({
            channel: pendingCorrection.channel,
            thread_ts: pendingCorrection.threadTs,
            text: `✅ Correction applied by <@${event.user}>. Row ${pendingCorrection.rowIndex}, \`${pendingCorrection.columnName}\` updated to \`${pendingCorrection.newValue}\`.`
          });
        } catch (sheetsError) {
          await client.chat.postMessage({
            channel: pendingCorrection.channel,
            thread_ts: pendingCorrection.threadTs,
            text: `❌ Failed to apply correction: ${(sheetsError as Error).message}`
          });
        }
      } else if (reaction === "x") {
        pendingAssistantCorrections.delete(lookupKey);
        await client.chat.postMessage({
          channel: pendingCorrection.channel,
          thread_ts: pendingCorrection.threadTs,
          text: `Correction discarded by <@${event.user}>. No changes were made.`
        });
      }
      return;
    }

    // ── EOD reaction handling ──────────────────────────────────────────────
    const eodEntry = pendingEodEntries.get(lookupKey);
    if (eodEntry) {
      if (reaction === "+1") {
        pendingEodEntries.delete(lookupKey);
        try {
          await ensureEodSheetHeader();
          const rowsAdded = await appendEodRows({
            extraction: eodEntry.extraction,
            source: eodEntry.source,
            slackChannel: eodEntry.channel,
            slackMessageTs: eodEntry.messageTs,
            recordedBy: eodEntry.recordedBy
          });
          await client.chat.postMessage({
            channel: eodEntry.channel,
            thread_ts: eodEntry.messageTs,
            text: `✅ EOD inventory saved by <@${event.user}>. Wrote *${rowsAdded}* row(s) to Google Sheets.`
          });
        } catch (sheetsError) {
          await client.chat.postMessage({
            channel: eodEntry.channel,
            thread_ts: eodEntry.messageTs,
            text: `❌ Error writing EOD inventory to Google Sheets: ${(sheetsError as Error).message}`
          });
        }
      } else if (reaction === "x") {
        pendingEodEntries.delete(lookupKey);
        await client.chat.postMessage({
          channel: eodEntry.channel,
          thread_ts: eodEntry.messageTs,
          text: `EOD inventory discarded by <@${event.user}>. Nothing was saved.`
        });
      }
      return;
    }

  } catch (error) {
    logger.error(error);
  }
});

// ── EOD text message handler ─────────────────────────────────────────────────

app.message(async ({ message, client, logger }) => {
  try {
    const msg = message as {
      subtype?: string;
      text?: string;
      ts: string;
      channel: string;
      user?: string;
      files?: Array<{ id: string; name: string; mimetype: string; url_private_download?: string }>;
    };

    if (env.INVENTORY_CHANNEL_ID && msg.channel !== env.INVENTORY_CHANNEL_ID) return;
    if ((msg.text || "").trimStart().startsWith("<@")) return; // handled by app_mention

    const hasAudioFile = (msg.files || []).some((f) => isMime("audio/", f.mimetype) && f.url_private_download);
    const isEod = isEodMessage(msg.text);

    // ── Voice memo (audio file upload) ──
    if (msg.subtype === "file_share" && hasAudioFile) {
      if (!env.OPENAI_API_KEY) {
        await client.chat.postMessage({
          channel: msg.channel,
          thread_ts: msg.ts,
          text: "⚠️ Voice memo received but `OPENAI_API_KEY` is not configured. Please set it to enable voice transcription."
        });
        return;
      }

      const audioFile = (msg.files || []).find((f) => isMime("audio/", f.mimetype) && f.url_private_download)!;
      await client.chat.postMessage({ channel: msg.channel, thread_ts: msg.ts, text: "🎙️ Transcribing voice memo..." });

      const buffer = await downloadSlackFile(audioFile.url_private_download!);
      const transcript = await transcribeAudio(buffer, audioFile.mimetype, audioFile.name);
      console.log("Whisper transcript:", transcript);

      const extraction = await extractFromText(transcript);
      const summaryKey = pendingKey(msg.channel, msg.ts);
      pendingEodEntries.set(summaryKey, {
        channel: msg.channel,
        messageTs: msg.ts,
        recordedBy: msg.user || "unknown",
        extraction,
        source: "voice",
        expiresAt: Date.now() + EOD_TTL_MS
      });

      const summaryMsg = await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.ts,
        text: `🎙️ *Transcript:* _${transcript}_\n\n${formatEodSummary(extraction)}`
      });

      if (summaryMsg.ts) {
        pendingEodEntries.set(pendingKey(msg.channel, summaryMsg.ts), pendingEodEntries.get(summaryKey)!);
      }
      return;
    }

    // ── EOD text message ──
    if (!msg.subtype && isEod) {
      const text = stripEodPrefix(msg.text || "");
      if (!text) return;

      await client.chat.postMessage({ channel: msg.channel, thread_ts: msg.ts, text: "🔍 Processing EOD inventory..." });

      const extraction = await extractFromText(text);
      const summaryKey = pendingKey(msg.channel, msg.ts);
      pendingEodEntries.set(summaryKey, {
        channel: msg.channel,
        messageTs: msg.ts,
        recordedBy: msg.user || "unknown",
        extraction,
        source: "text",
        expiresAt: Date.now() + EOD_TTL_MS
      });

      const summaryMsg = await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.ts,
        text: formatEodSummary(extraction)
      });

      if (summaryMsg.ts) {
        pendingEodEntries.set(pendingKey(msg.channel, summaryMsg.ts), pendingEodEntries.get(summaryKey)!);
      }
    }
  } catch (error) {
    logger.error(error);
    const msg = message as { channel?: string; ts?: string };
    if (msg.channel && msg.ts) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: msg.ts,
        text: `❌ EOD processing failed: ${(error as Error).message}`
      }).catch(() => {});
    }
  }
});

// ── Assistant correction reaction handling ────────────────────────────────────
// (checked first in reaction_added, before EOD and delivery checks)

// ── @mention handler ─────────────────────────────────────────────────────────

app.event("app_mention", async ({ event, client, logger }) => {
  const channel = event.channel;
  const threadTs = (event as { thread_ts?: string }).thread_ts ?? event.ts;
  const userText = event.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
  const userId = (event as { user?: string }).user ?? "unknown";

  if (env.ASSISTANT_CHANNEL_ID && channel !== env.ASSISTANT_CHANNEL_ID) return;
  if (!userText) {
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Hi! Ask me about inventory or deliveries — e.g. _\"what's the EOD count for today?\"_ or _\"show me Caruso's deliveries this week\"_."
    });
    return;
  }

  try {
    const historyKey = pendingKey(channel, threadTs);
    let history = threadHistories.get(historyKey);
    if (!history) {
      history = { threadTs, channel, messages: [], lastActivityAt: Date.now() };
      threadHistories.set(historyKey, history);
    }

    history.messages.push({ role: "user", content: userText });
    history.lastActivityAt = Date.now();

    await client.chat.postMessage({ channel, thread_ts: threadTs, text: "_Thinking..._" });

    const { responseText } = await runAssistantLoop({
      history: history.messages,
      channel,
      threadTs,
      requestedBy: userId,
      onCorrectionProposed: async (correction, summaryText) => {
        const msg = await client.chat.postMessage({ channel, thread_ts: threadTs, text: summaryText });
        const correctionKey = pendingKey(channel, msg.ts!);
        pendingAssistantCorrections.set(correctionKey, { ...correction, summaryMessageTs: msg.ts! });
        return { messageTs: msg.ts! };
      }
    });

    history.messages.push({ role: "assistant", content: responseText });
    history.lastActivityAt = Date.now();

    await client.chat.postMessage({ channel, thread_ts: threadTs, text: responseText });
  } catch (error) {
    logger.error(error);
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: "Sorry, something went wrong. Please try again."
    }).catch(() => {});
  }
});

// ── Alexa voice webhook ───────────────────────────────────────────────────────

async function handleAlexaRequest(body: unknown, res: ServerResponse): Promise<void> {
  const alexa = body as Record<string, unknown>;
  const request = alexa.request as Record<string, unknown>;
  const requestType = request?.type as string;

  function alexaReply(text: string, endSession: boolean): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      version: "1.0",
      response: { outputSpeech: { type: "PlainText", text }, shouldEndSession: endSession }
    }));
  }

  if (requestType === "LaunchRequest") {
    alexaReply("What inventory would you like to log?", false);
    return;
  }

  if (requestType === "SessionEndedRequest") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ version: "1.0", response: {} }));
    return;
  }

  if (requestType === "IntentRequest") {
    const intent = request.intent as Record<string, unknown>;
    const slots = intent?.slots as Record<string, { value?: string }> | undefined;
    const text = slots?.Query?.value ?? slots?.query?.value ?? "";

    if (!text) {
      alexaReply("I didn't catch that. Please try again.", false);
      return;
    }

    const extraction = await extractFromText(text);
    await ensureEodSheetHeader();
    const rowsAdded = await appendEodRows({
      extraction,
      source: "voice",
      slackChannel: env.INVENTORY_CHANNEL_ID ?? "alexa",
      slackMessageTs: Date.now().toString(),
      recordedBy: "alexa"
    });

    if (env.INVENTORY_CHANNEL_ID) {
      const lines = extraction.line_items.map((item) => {
        const qty = item.quantity_raw ?? item.quantity ?? "?";
        const unit = item.unit ? ` ${item.unit}(s)` : "";
        const name = item.item_name_normalized ?? item.item_name_raw ?? "Unknown item";
        return `• ${qty}${unit} ${name}`;
      });
      await app.client.chat.postMessage({
        channel: env.INVENTORY_CHANNEL_ID,
        text: `🎙️ *Alexa voice log — ${extraction.date ?? new Date().toISOString().slice(0, 10)}*\n${lines.join("\n")}\n_Wrote ${rowsAdded} row(s) to Google Sheets._`
      });
    }

    alexaReply(`Got it. Logged ${rowsAdded} item${rowsAdded !== 1 ? "s" : ""}.`, true);
    return;
  }

  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unknown request type" }));
}

async function handleDashboardRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!env.DASHBOARD_TOKEN) {
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const token = url.searchParams.get("token") ?? "";
  if (token !== env.DASHBOARD_TOKEN) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  const viewParam = url.searchParams.get("view");
  const view: "daily" | "weekly" = viewParam === "weekly" ? "weekly" : "daily";
  let periods: number;
  if (view === "weekly") {
    const weeksParam = parseInt(url.searchParams.get("weeks") ?? "4", 10);
    periods = weeksParam === 12 ? 12 : 4;
  } else {
    const daysParam = parseInt(url.searchParams.get("days") ?? "7", 10);
    periods = daysParam === 30 ? 30 : 7;
  }

  try {
    const [inboundRows, outboundRows] = await Promise.all([
      readDeliveryRows({ limit: 5000 }),
      readEodRows({ limit: 5000 })
    ]);
    const html = buildDashboardHtml({
      view,
      periods,
      token: env.DASHBOARD_TOKEN,
      inboundRows,
      outboundRows,
      generatedAt: new Date()
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    console.error("Dashboard error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
}

function startHttpServer(): void {
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && path === "/dashboard") {
      await handleDashboardRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/voice") {
      // Accept Bearer token (for curl/testing) OR Alexa signature headers (for real device)
      const authHeader = req.headers["authorization"] ?? "";
      const hasAlexaSignature = Boolean(req.headers["signaturecertchainurl"]);
      if (!hasAlexaSignature && authHeader !== `Bearer ${env.VOICE_WEBHOOK_SECRET}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        await handleAlexaRequest(body, res);
      } catch (err) {
        console.error("Voice webhook error:", (err as Error).message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const port = process.env.PORT ? parseInt(process.env.PORT) : env.VOICE_PORT;
  server.listen(port, () => {
    const routes: string[] = [];
    if (env.VOICE_WEBHOOK_SECRET) routes.push("/voice");
    if (env.DASHBOARD_TOKEN) routes.push("/dashboard");
    console.log(`HTTP server listening on port ${port} (routes: ${routes.join(", ") || "none"})`);
  });
}

async function start(): Promise<void> {
  if (env.SLACK_APP_TOKEN) {
    await app.start();
    console.log("Slack app started in Socket Mode.");
  } else {
    await app.start(env.SLACK_PORT);
    console.log(`Slack app started on port ${env.SLACK_PORT}.`);
  }

  if (env.VOICE_WEBHOOK_SECRET || env.DASHBOARD_TOKEN) {
    startHttpServer();
  }
}

start().catch((err) => {
  console.error("Failed to start app", err);
  process.exit(1);
});
