import { createHash } from "crypto";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import axios from "axios";
import { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "./config.js";
import {
  appendExtractionRows,
  appendInKindDonationRow,
  appendInKindSummaryRow,
  ensureSheetHeader,
  appendEodRows,
  ensureEodSheetHeader,
  updateSheetCell,
  readDeliveryRows,
  readEodRows,
  appendSummaryRow,
  ensureSummarySheetHeader,
  ensureCorrectionsLogHeader,
  ensureExtractionTracesHeader,
  appendCorrectionRow,
  groupSlips,
  groupEodSlips,
  stampSlipApproval,
  stampEodApproval,
  clearSlipApproval,
  clearEodApproval,
  recomputeSummaryForSlip,
  appendExtractionTrace,
  appendPromptSuggestion,
  readPromptSuggestions,
  updatePromptSuggestionStatus,
  ensurePromptSuggestionsHeader,
  readRescueDedupeKeys,
  rescueDedupeKey,
  SHEET_HEADERS,
  EOD_SHEET_HEADERS
} from "./sheets.js";
import { buildDashboardHtml, buildCsvExport } from "./dashboard.js";
import { buildReviewListHtml, buildSlipDetailHtml, buildSuggestionsListHtml, buildOutboundListHtml, buildOutboundSlipDetailHtml, decodeSlipKey, encodeSlipKey } from "./review.js";
import { buildLandingHtml } from "./landing.js";
import { buildDonateHtml, parseDonateFormBody } from "./donate.js";
import {
  extractFromImage,
  extractFromText,
  transcribeAudio,
  guessSupplierFromFilename,
  classifyImage,
  extractFromWhiteboard,
  ensureRescueSkeleton,
  getInvoiceSupplierPrompt,
  getInvoiceSystemPrompt
} from "./extraction.js";
import { runAssistantLoop } from "./assistant.js";
import { reconcileWithCarusoCatalog } from "./carusoCatalog.js";
import type { ExtractionResult, EodExtractionResult, Supplier, ThreadHistory, PendingAssistantCorrection, ProgramType } from "./types.js";

interface ProcessedFileExtraction {
  fileId: string;
  contentHash: string;
  fileName: string;
  photoUrl: string;
  extraction: ExtractionResult;
  flagPossibleDuplicate?: boolean;
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
// Natural-key dedupe for Food Lifeline grocery rescue: `food_lifeline:<donor_lower>:<delivery_date>`.
// These forms have no invoice number, so we dedupe on donor + date. Populated from
// the sheet at boot so the check survives Railway restarts.
const processedRescueKeys = new Set<string>();

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
  if (t.includes("weigelt")) return "weigelt";
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
  unreadableFees: string[];
} {
  let lineItems = 0;
  let fees = 0;
  let totalConfidence = 0;
  const unreadableFees: string[] = [];
  for (const f of files) {
    lineItems += f.extraction.line_items.length;
    fees += f.extraction.fees.length;
    for (const li of f.extraction.line_items) {
      totalConfidence += li.confidence;
    }
    for (const fee of f.extraction.fees) {
      if (fee.amount === null) {
        unreadableFees.push(fee.description);
      }
    }
  }
  const avgConfidence = lineItems > 0 ? totalConfidence / lineItems : 0;
  return { lineItems, fees, avgConfidence, unreadableFees };
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

const PROGRAM_LABEL: Record<string, string> = {
  home_delivery: "Home Delivery",
  in_person_shopping: "In Person Shopping",
  pre_made_bags: "Pre Made Bags",
  unknown: "Unknown"
};

function summarizeProgramCounts(files: ProcessedWhiteboardFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    for (const li of f.extraction.line_items) {
      const key = li.program_type ?? "unknown";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return "";
  const order = ["home_delivery", "in_person_shopping", "pre_made_bags", "unknown"];
  const parts: string[] = [];
  for (const key of order) {
    const n = counts.get(key);
    if (!n) continue;
    parts.push(`${PROGRAM_LABEL[key]}: ${n}`);
  }
  return parts.join(" · ");
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
      const amount = fee.amount === null ? "?" : `$${fee.amount.toFixed(2)}`;
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

  try {
    await ensureSheetHeader();
    await ensureSummarySheetHeader();
    await ensureCorrectionsLogHeader();
    await ensureExtractionTracesHeader();
    let totalRows = 0;
    for (const file of processedFiles) {
      const rowsAdded = await appendExtractionRows({
        extraction: file.extraction,
        photoUrl: file.photoUrl,
        slackChannel: channel,
        slackMessageTs: messageTs,
        uploadedBy,
        skipAutoApprove: file.flagPossibleDuplicate
      });
      totalRows += rowsAdded;
      await appendSummaryRow({ extraction: file.extraction, photoUrl: file.photoUrl });
    }

    for (const file of processedFiles) {
      processedFileIds.add(file.fileId);
      processedContentHashes.add(file.contentHash);
      if (file.extraction.invoice_or_order_number && file.extraction.supplier !== "unknown") {
        processedInvoiceKeys.add(`${file.extraction.supplier}:${file.extraction.invoice_or_order_number}`);
      }
    }
    processedMessageKeys.add(messageKey);

    const unreadableFeesLine = summary.unreadableFees.length
      ? `\n⚠️ *Unreadable fee amount${summary.unreadableFees.length > 1 ? "s" : ""}* — fill in manually in the sheet: ${summary.unreadableFees.map((d) => `_${d}_`).join(", ")}`
      : "";
    const needsReview = summary.avgConfidence < env.REVIEW_CONFIDENCE_THRESHOLD;
    const statusLine = needsReview
      ? `⚠️ *Low confidence (${confidencePct}%)* — logged ${totalRows} row(s), flagged for review at https://review.loadslip.com`
      : `✅ *Logged ${totalRows} row(s) to Google Sheets.*`;
    await client.chat.postMessage({
      channel,
      thread_ts: messageTs,
      text: `${headerLine}\n\n${tableText}\n\n${statusLine}${unreadableFeesLine}`
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
  const programSummary = summarizeProgramCounts(whiteboardFiles);
  const headerLine =
    `📋 *Outbound Whiteboard* — Files: *${whiteboardFiles.length}* | Line items: *${summary.lineItems}*\n` +
    (programSummary ? `📦 ${programSummary}\n` : "") +
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
      const confidences = file.extraction.line_items
        .map((li) => li.confidence)
        .filter((c): c is number => typeof c === "number" && Number.isFinite(c));
      const minConf = confidences.length ? Math.min(...confidences) : null;
      const autoApprove = minConf !== null && minConf >= env.REVIEW_CONFIDENCE_THRESHOLD;
      const rowsAdded = await appendEodRows({
        extraction: file.extraction,
        source: "whiteboard",
        slackChannel: channel,
        slackMessageTs: messageTs,
        recordedBy: uploadedBy,
        photoUrl: file.photoUrl,
        autoApprove
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

    const allFiles = (message.files || []).filter(
      (f) => (isMime("image/", f.mimetype) || f.mimetype === "application/pdf") && f.url_private_download
    );
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

      const { result: extraction, trace } = await extractFromImage({
        imageBytes: buffer,
        mimeType: file.mimetype,
        filename: file.name,
        supplierHint
      });

      const carusoRec = reconcileWithCarusoCatalog(extraction);
      if (carusoRec.hits > 0) {
        console.log(`caruso catalog reconcile file=${file.name} hits=${carusoRec.hits} overwrites=${carusoRec.overwrites}`);
      }

      // Persist the raw thinking + extracted JSON so we can review traces long
      // after Railway's log buffer flushes on redeploy. Fire-and-forget: a
      // Sheets outage must not block the actual write to Inbound Delivery Log.
      appendExtractionTrace({
        trace,
        extraction,
        photoUrl: file.url_private_download,
        carusoReconcileHits: carusoRec.hits,
        carusoReconcileOverwrites: carusoRec.overwrites
      }).catch((err) => {
        console.warn(`appendExtractionTrace failed file=${file.name}: ${(err as Error).message}`);
      });

      if (!extraction.delivery_date) {
        extraction.delivery_date = slackTsToLocalDate(message.ts);
        extraction.source_warnings.push(
          `delivery_date not found on document — defaulted to upload date (${extraction.delivery_date})`
        );
      }

      if (!extraction.destination_org || !extraction.destination_org.trim()) {
        extraction.destination_org = "Rainier Valley Food Bank";
        extraction.source_warnings.push(
          `destination_org not found on document — defaulted to Rainier Valley Food Bank`
        );
      }

      // Grocery rescue slips always have a fixed set of 10 category rows on the
      // paper form. Deterministically enforce that the extraction contains all
      // 10 (skeleton-fill missing ones) so reviewers can correct blanks
      // without needing to add a row by hand.
      ensureRescueSkeleton(extraction);

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

      const rescueKey = rescueDedupeKey(extraction.supplier, extraction.donor_org, extraction.delivery_date);
      let flagPossibleDuplicate = false;
      if (rescueKey && processedRescueKeys.has(rescueKey)) {
        flagPossibleDuplicate = true;
        extraction.source_warnings.push(
          `possible duplicate — an existing food_lifeline rescue slip for ${extraction.donor_org} on ${extraction.delivery_date} was already logged`
        );
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: `⚠️ Possible duplicate — we already have a *${extraction.donor_org}* rescue slip for *${extraction.delivery_date}*. Logging anyway and flagging for review at https://review.loadslip.com`
        });
      }
      if (rescueKey) processedRescueKeys.add(rescueKey);

      processedFiles.push({
        fileId: file.id,
        contentHash,
        fileName: file.name,
        photoUrl: file.url_private_download,
        extraction,
        flagPossibleDuplicate
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
    const message = friendlyErrorMessage(e);
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

function friendlyErrorMessage(e: Error): string {
  const raw = `${e.message ?? ""} ${(e as { stack?: string }).stack ?? ""}`;
  // Anthropic returns this exact string when the workspace credit balance is exhausted.
  if (/credit balance is too low/i.test(raw)) {
    return [
      "⚠️ *Bot is offline — Anthropic API credit ran out.*",
      "Nothing was logged for this slip. An admin needs to top up at console.anthropic.com → *Plans & Billing*, and then this can be re-uploaded."
    ].join("\n");
  }
  if (/rate.?limit|429/i.test(raw)) {
    return [
      "⚠️ *Bot hit Anthropic's rate limit.*",
      "Wait a minute and re-upload, or ping an admin if it keeps happening."
    ].join("\n");
  }
  if (/exceeds.*grid limits|Unable to parse range/i.test(raw)) {
    return [
      "⚠️ *Sheet schema is out of sync.*",
      "An admin needs to check the Inbound Delivery Log columns. Nothing was logged for this slip."
    ].join("\n");
  }
  return "Inventory processing failed. Check app logs for details.";
}

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

const cfJwks = env.CF_ACCESS_TEAM_DOMAIN
  ? createRemoteJWKSet(new URL(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`))
  : null;

async function verifyCfAccessJwt(req: IncomingMessage): Promise<{ email: string } | null> {
  if (!cfJwks || !env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD_TAG) return null;
  const raw = req.headers["cf-access-jwt-assertion"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, cfJwks, {
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
      audience: env.CF_ACCESS_AUD_TAG
    });
    const email = typeof payload.email === "string" ? payload.email : "";
    return email ? { email } : null;
  } catch (err) {
    console.warn("cf-access jwt verify failed:", (err as Error).message);
    return null;
  }
}

// Best-effort email lookup for the current request. Non-throwing: returns null
// when we can't identify the user (e.g. token-fallback path). Callers that need
// hard auth still go through authRequest first — this is just for attribution.
async function requestUserEmail(req: IncomingMessage): Promise<string | null> {
  const jwt = await verifyCfAccessJwt(req);
  return jwt?.email ?? null;
}

async function authRequest(req: IncomingMessage, res: ServerResponse): Promise<URL | null> {
  const url = new URL(req.url ?? "/", "http://localhost");

  const jwt = await verifyCfAccessJwt(req);
  if (jwt) {
    console.log(`auth path=jwt user=${jwt.email} path=${url.pathname}`);
    return url;
  }

  if (env.DASHBOARD_TOKEN) {
    const token = url.searchParams.get("token") ?? "";
    if (token === env.DASHBOARD_TOKEN) {
      console.log(`auth path=token-fallback path=${url.pathname}`);
      return url;
    }
  }

  if (!env.DASHBOARD_TOKEN && !cfJwks) {
    res.writeHead(404);
    res.end();
    return null;
  }
  res.writeHead(401, { "Content-Type": "text/plain" });
  res.end("Unauthorized");
  return null;
}

async function handleDashboardRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await authRequest(req, res);
  if (!url) return;

  const viewParam = url.searchParams.get("view");
  const view: "daily" | "weekly" = viewParam === "weekly" ? "weekly" : "daily";
  const rangeParam = url.searchParams.get("range");
  const range: "1w" | "4w" = rangeParam === "4w" ? "4w" : "1w";
  const format = url.searchParams.get("format");
  const programParam = url.searchParams.get("program");
  const program: ProgramType | null =
    programParam === "home_delivery" || programParam === "in_person_shopping" || programParam === "pre_made_bags"
      ? programParam
      : null;

  try {
    const [inboundRows, outboundRowsAll] = await Promise.all([
      readDeliveryRows({ limit: 5000 }),
      readEodRows({ limit: 5000 })
    ]);
    const outboundRows = program ? outboundRowsAll.filter((r) => r.program_type === program) : outboundRowsAll;

    if (format === "raw") {
      const dateParam = url.searchParams.get("date");
      let from = url.searchParams.get("from");
      let to = url.searchParams.get("to");
      if (dateParam) {
        from = dateParam;
        to = dateParam;
      }
      const inFiltered = from || to
        ? inboundRows.filter((r) => {
            const d = r.delivery_date;
            if (!d) return false;
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
          })
        : inboundRows;
      const outFiltered = from || to
        ? outboundRows.filter((r) => {
            const d = r.date;
            if (!d) return false;
            if (from && d < from) return false;
            if (to && d > to) return false;
            return true;
          })
        : outboundRows;
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        from: from ?? null,
        to: to ?? null,
        program: program,
        inbound: inFiltered,
        outbound: outFiltered
      }));
      return;
    }

    if (format === "csv") {
      const { filename, csv } = buildCsvExport({ range, inboundRows, outboundRows, program });
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store"
      });
      res.end(csv);
      return;
    }

    const html = buildDashboardHtml({
      view,
      range,
      program,
      token: env.DASHBOARD_TOKEN ?? "",
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

// ── Review UI handlers ──────────────────────────────────────────────────────

async function reviewAuth(req: IncomingMessage, res: ServerResponse): Promise<URL | null> {
  return authRequest(req, res);
}

async function handleReviewListRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  const tab = url.searchParams.get("tab") ?? "queue";

  try {
    if (tab === "suggestions") {
      const email = await requestUserEmail(req);
      const suggestions = await readPromptSuggestions({ limit: 200 });
      const pendingCount = suggestions.filter((s) => s.status === "pending").length;
      const html = buildSuggestionsListHtml({
        suggestions,
        currentEmail: email,
        isAdmin: email === env.ADMIN_EMAIL,
        pendingCount,
        generatedAt: new Date()
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }

    if (tab === "outbound") {
      await ensureEodSheetHeader();
      const eodRows = await readEodRows({ limit: 5000 });
      const eodSlips = groupEodSlips(eodRows);
      const pendingSuggestions = await readPromptSuggestions({ status: "pending", limit: 200 });
      const html = buildOutboundListHtml({
        slips: eodSlips,
        threshold: env.REVIEW_CONFIDENCE_THRESHOLD,
        generatedAt: new Date(),
        pendingSuggestionCount: pendingSuggestions.length
      });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }

    const pendingOnly = tab !== "history";
    const rows = await readDeliveryRows({ limit: 5000 });
    const slips = groupSlips(rows);
    const threshold = env.REVIEW_CONFIDENCE_THRESHOLD;
    const pendingSuggestions = await readPromptSuggestions({ status: "pending", limit: 200 });
    const html = buildReviewListHtml({
      slips,
      pendingOnly,
      threshold,
      token: env.DASHBOARD_TOKEN ?? "",
      generatedAt: new Date(),
      pendingSuggestionCount: pendingSuggestions.length
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    console.error("Review list error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
}

async function handleSlipDetailRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  const slipParam = url.searchParams.get("slip") ?? "";
  let slipKey = "";
  try {
    slipKey = decodeSlipKey(slipParam);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid slip key");
    return;
  }
  if (!slipKey) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Missing slip key");
    return;
  }

  try {
    const rows = await readDeliveryRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.photo_url === slipKey);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }
    const [slip] = groupSlips(slipRows);
    const html = buildSlipDetailHtml({
      slip,
      rows: slipRows,
      token: env.DASHBOARD_TOKEN ?? "",
      supplierPrompt: getInvoiceSupplierPrompt(slip.supplier ?? "unknown"),
      systemPrompt: getInvoiceSystemPrompt()
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    console.error("Slip detail error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return {};
  return JSON.parse(raw);
}

const SLIP_LEVEL_FIELDS = new Set([
  "supplier",
  "document_type",
  "invoice_date",
  "delivery_date",
  "invoice_or_order_number",
  "destination_org",
  "donor_org",
  "is_donation"
]);
const ROW_LEVEL_FIELDS = new Set([
  "item_code_raw",
  "item_name_raw",
  "item_name_normalized",
  "quantity_ordered",
  "quantity",
  "quantity_raw",
  "unit",
  "pack_size_raw",
  "approx_weight",
  "category",
  "unit_cost",
  "line_total",
  "confidence",
  "is_fee",
  "notes"
]);

async function handleReviewEditRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;

  try {
    const body = (await readJsonBody(req)) as { slip?: string; row_index?: number; field?: string; new_value?: string; reason?: string };
    const slipEnc = body.slip ?? "";
    const rowIndex = Number(body.row_index);
    const field = body.field ?? "";
    const newValue = body.new_value ?? "";
    const reason = body.reason ?? null;

    if (!slipEnc || !Number.isInteger(rowIndex) || !field) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing slip/row_index/field");
      return;
    }
    // "pounds" is a virtual field for grocery rescue slips: one Pounds cell on
    // the paper form maps to three sheet columns (quantity, quantity_raw,
    // approx_weight). We fan it out below.
    const isPoundsVirtual = field === "pounds";
    if (!isPoundsVirtual && !SHEET_HEADERS.includes(field)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Unknown field: ${field}`);
      return;
    }
    const isSlipLevel = SLIP_LEVEL_FIELDS.has(field);
    if (!isPoundsVirtual && !isSlipLevel && !ROW_LEVEL_FIELDS.has(field)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Field not editable: ${field}`);
      return;
    }

    await ensureSheetHeader();

    const slipKey = decodeSlipKey(slipEnc);
    const rows = await readDeliveryRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.photo_url === slipKey);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }

    const targets = isSlipLevel ? slipRows : slipRows.filter((r) => r.rowIndex === rowIndex);
    if (targets.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Row not found in slip");
      return;
    }

    const user = (req.headers["x-review-user"] as string) || "review-ui";
    // Pounds edits fan out to three columns; per-column comparison happens inside the loop.
    const fanoutFields = isPoundsVirtual ? ["quantity", "quantity_raw", "approx_weight"] : [field];
    for (const target of targets) {
      for (const realField of fanoutFields) {
        const oldValue = (target as unknown as Record<string, string | null>)[realField];
        if (oldValue === newValue) continue;
        await updateSheetCell({
          worksheetName: env.GOOGLE_WORKSHEET_NAME,
          rowIndex: target.rowIndex,
          columnName: realField,
          newValue: newValue === "" ? null : newValue
        });
        await appendCorrectionRow({
          user,
          slipKey,
          sheet: env.GOOGLE_WORKSHEET_NAME,
          rowIndex: target.rowIndex,
          field: isPoundsVirtual ? `pounds→${realField}` : realField,
          oldValue,
          newValue,
          reason
        });
      }
    }

    await clearSlipApproval(slipRows.map((r) => r.rowIndex));
    const fresh = await readDeliveryRows({ limit: 5000 });
    const freshSlipRows = fresh.filter((r) => r.photo_url === slipKey);
    await recomputeSummaryForSlip(freshSlipRows);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Review edit error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

async function handleReviewPhotoRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  const slipParam = url.searchParams.get("slip") ?? "";
  let photoUrl = "";
  try {
    photoUrl = decodeSlipKey(slipParam);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid slip");
    return;
  }
  if (!photoUrl || !/^https?:\/\//.test(photoUrl)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Slip has no photo URL");
    return;
  }
  try {
    const upstream = await axios.get<ArrayBuffer>(photoUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      validateStatus: () => true
    });
    if (upstream.status !== 200) {
      res.writeHead(upstream.status, { "Content-Type": "text/plain" });
      res.end(`Upstream ${upstream.status}`);
      return;
    }
    const contentType = (upstream.headers["content-type"] as string | undefined) ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600"
    });
    res.end(Buffer.from(upstream.data));
  } catch (err) {
    console.error("Review photo error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Failed to fetch photo");
  }
}

async function notifyAdminOfSuggestion(params: {
  submittedBy: string;
  supplier: string;
  suggestionText: string;
  slipPhotoUrl: string | null;
}): Promise<void> {
  if (!env.ADMIN_SLACK_USER_ID) return;
  const { submittedBy, supplier, suggestionText, slipPhotoUrl } = params;
  const base = env.CF_ACCESS_TEAM_DOMAIN ? "https://review.loadslip.com" : "";
  const suggestionsLink = base ? `${base}/review?tab=suggestions` : "/review?tab=suggestions";
  const slipLink = slipPhotoUrl && base ? `${base}/review/slip?slip=${encodeSlipKey(slipPhotoUrl)}` : null;

  const text = [
    `*New prompt suggestion* — ${supplier || "general"}`,
    `From: ${submittedBy}`,
    "",
    `> ${suggestionText.split("\n").join("\n> ")}`,
    "",
    `<${suggestionsLink}|Review in the UI>${slipLink ? ` · <${slipLink}|source slip>` : ""}`
  ].join("\n");

  try {
    await app.client.chat.postMessage({ channel: env.ADMIN_SLACK_USER_ID, text });
  } catch (err) {
    console.warn(`admin suggestion DM failed: ${(err as Error).message}`);
  }
}

async function handlePromptViewRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  const supplier = (url.searchParams.get("supplier") ?? "").trim();
  const prompt = getInvoiceSupplierPrompt(supplier);
  if (!prompt) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`No supplier prompt for "${supplier}"`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(prompt);
}

async function handleReviewSuggestRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  try {
    const body = (await readJsonBody(req)) as { slip?: string; supplier?: string; suggestion_text?: string };
    const slipEnc = body.slip ?? "";
    const supplier = (body.supplier ?? "").trim() || "general";
    const suggestionText = (body.suggestion_text ?? "").trim();
    if (!suggestionText) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("suggestion_text is required");
      return;
    }
    if (suggestionText.length > 4000) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("suggestion_text too long (max 4000 chars)");
      return;
    }

    let slipPhotoUrl: string | null = null;
    if (slipEnc) {
      try { slipPhotoUrl = decodeSlipKey(slipEnc); } catch { slipPhotoUrl = null; }
    }

    const submittedBy = (await requestUserEmail(req)) ?? "review-ui";
    await appendPromptSuggestion({ submittedBy, supplier, slipPhotoUrl, suggestionText });
    console.log(`prompt suggestion submitted by=${submittedBy} supplier=${supplier} len=${suggestionText.length}`);

    // Fire-and-forget Slack DM — Sheets write is what actually matters.
    notifyAdminOfSuggestion({ submittedBy, supplier, suggestionText, slipPhotoUrl });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Review suggest error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

async function handleReviewSuggestResolveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  try {
    const email = await requestUserEmail(req);
    if (email !== env.ADMIN_EMAIL) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Only the admin can resolve prompt suggestions.");
      return;
    }
    const body = (await readJsonBody(req)) as { row_index?: number; status?: string; notes?: string };
    const rowIndex = Number(body.row_index);
    const status = body.status;
    const notes = (body.notes ?? "").trim();
    if (!Number.isInteger(rowIndex) || rowIndex < 2) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid row_index");
      return;
    }
    if (status !== "approved" && status !== "rejected") {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("status must be 'approved' or 'rejected'");
      return;
    }
    await updatePromptSuggestionStatus({ rowIndex, status, resolvedBy: email, notes: notes || null });
    console.log(`prompt suggestion resolved row=${rowIndex} status=${status} by=${email}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Review suggest resolve error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

async function handleReviewApproveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  try {
    const body = (await readJsonBody(req)) as { slip?: string };
    const slipEnc = body.slip ?? "";
    if (!slipEnc) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing slip");
      return;
    }
    await ensureSheetHeader();

    const slipKey = decodeSlipKey(slipEnc);
    const rows = await readDeliveryRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.photo_url === slipKey);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }
    const user = (req.headers["x-review-user"] as string) || "review-ui";
    await stampSlipApproval({
      slipKey,
      rowIndexes: slipRows.map((r) => r.rowIndex),
      approvedBy: user
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Review approve error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

// ── Outbound review handlers ────────────────────────────────────────────────

const EOD_SLIP_LEVEL_FIELDS = new Set(["date"]);
const EOD_ROW_LEVEL_FIELDS = new Set([
  "item_name_raw",
  "item_name_normalized",
  "quantity",
  "quantity_raw",
  "unit",
  "category",
  "program_type",
  "notes",
  "confidence"
]);

async function handleOutboundSlipDetailRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  const slipParam = url.searchParams.get("slip") ?? "";
  let slipKey = "";
  try {
    slipKey = decodeSlipKey(slipParam);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Invalid slip key");
    return;
  }
  const [channel, ts] = slipKey.split(":", 2);
  if (!channel || !ts) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Malformed outbound slip key");
    return;
  }

  try {
    await ensureEodSheetHeader();
    const rows = await readEodRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.slack_channel === channel && r.slack_message_ts === ts);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }
    const [slip] = groupEodSlips(slipRows);
    const html = buildOutboundSlipDetailHtml({ slip, rows: slipRows });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    console.error("Outbound slip detail error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal server error");
  }
}

async function handleOutboundEditRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;

  try {
    const body = (await readJsonBody(req)) as { slip?: string; row_index?: number; field?: string; new_value?: string; reason?: string };
    const slipEnc = body.slip ?? "";
    const rowIndex = Number(body.row_index);
    const field = body.field ?? "";
    const newValue = body.new_value ?? "";
    const reason = body.reason ?? null;

    if (!slipEnc || !Number.isInteger(rowIndex) || !field) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing slip/row_index/field");
      return;
    }
    if (!EOD_SHEET_HEADERS.includes(field)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Unknown field: ${field}`);
      return;
    }
    const isSlipLevel = EOD_SLIP_LEVEL_FIELDS.has(field);
    if (!isSlipLevel && !EOD_ROW_LEVEL_FIELDS.has(field)) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`Field not editable: ${field}`);
      return;
    }

    await ensureEodSheetHeader();
    const slipKey = decodeSlipKey(slipEnc);
    const [channel, ts] = slipKey.split(":", 2);
    if (!channel || !ts) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Malformed outbound slip key");
      return;
    }
    const rows = await readEodRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.slack_channel === channel && r.slack_message_ts === ts);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }
    const targets = isSlipLevel ? slipRows : slipRows.filter((r) => r.rowIndex === rowIndex);
    if (targets.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Row not found in slip");
      return;
    }
    const user = (req.headers["x-review-user"] as string) || "review-ui";
    for (const target of targets) {
      const oldValue = (target as unknown as Record<string, string | null>)[field];
      if (oldValue === newValue) continue;
      await updateSheetCell({
        worksheetName: env.EOD_WORKSHEET_NAME,
        rowIndex: target.rowIndex,
        columnName: field,
        newValue: newValue === "" ? null : newValue
      });
      await appendCorrectionRow({
        user,
        slipKey,
        sheet: env.EOD_WORKSHEET_NAME,
        rowIndex: target.rowIndex,
        field,
        oldValue,
        newValue,
        reason
      });
    }
    await clearEodApproval(slipRows.map((r) => r.rowIndex));

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Outbound edit error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

async function handleOutboundApproveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await reviewAuth(req, res);
  if (!url) return;
  try {
    const body = (await readJsonBody(req)) as { slip?: string };
    const slipEnc = body.slip ?? "";
    if (!slipEnc) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing slip");
      return;
    }
    await ensureEodSheetHeader();
    const slipKey = decodeSlipKey(slipEnc);
    const [channel, ts] = slipKey.split(":", 2);
    if (!channel || !ts) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Malformed outbound slip key");
      return;
    }
    const rows = await readEodRows({ limit: 5000 });
    const slipRows = rows.filter((r) => r.slack_channel === channel && r.slack_message_ts === ts);
    if (slipRows.length === 0) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Slip not found");
      return;
    }
    const user = (req.headers["x-review-user"] as string) || "review-ui";
    await stampEodApproval({
      rowIndexes: slipRows.map((r) => r.rowIndex),
      approvedBy: user
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error("Outbound approve error:", (err as Error).message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end((err as Error).message);
  }
}

async function handleDonateGetRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await authRequest(req, res);
  if (!url) return;
  const staffEmail = await requestUserEmail(req);
  const html = buildDonateHtml({ staffEmail });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(html);
}

async function handleDonatePostRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = await authRequest(req, res);
  if (!url) return;
  const staffEmail = (await requestUserEmail(req)) ?? "unknown";
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const { submission, errors } = parseDonateFormBody(body);
    if (errors.length) {
      const html = buildDonateHtml({ staffEmail, notice: { kind: "err", text: errors.join(" ") } });
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
      return;
    }
    const submissionId = `donate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const full = { ...submission, submissionId, submittedBy: staffEmail };
    await ensureSheetHeader();
    await ensureSummarySheetHeader();
    await appendInKindDonationRow(full);
    await appendInKindSummaryRow(full);
    const donorLabel = submission.donorAnonymous ? "Anonymous donor" : submission.donorName || "donor";
    const html = buildDonateHtml({
      staffEmail,
      notice: { kind: "ok", text: `Logged donation from ${donorLabel}. Ready for the next one.` }
    });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch (err) {
    console.error("Donate submit error:", (err as Error).message);
    const html = buildDonateHtml({
      staffEmail,
      notice: { kind: "err", text: `Could not log donation: ${(err as Error).message}` }
    });
    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  }
}

function startHttpServer(): void {
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && path === "/") {
      // Public marketing landing page — no auth. Uses the review origin so
      // "Sign in" bounces the visitor straight into the Access-gated app.
      const reviewUrl = env.CF_ACCESS_TEAM_DOMAIN ? "https://review.loadslip.com/review" : "/review";
      const html = buildLandingHtml({ reviewUrl });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && path === "/dashboard") {
      await handleDashboardRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/review") {
      await handleReviewListRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/donate") {
      await handleDonateGetRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/donate") {
      await handleDonatePostRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/review/slip") {
      await handleSlipDetailRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/review/outbound/slip") {
      await handleOutboundSlipDetailRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/edit") {
      await handleReviewEditRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/approve") {
      await handleReviewApproveRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/outbound/edit") {
      await handleOutboundEditRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/outbound/approve") {
      await handleOutboundApproveRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/api/prompts") {
      await handlePromptViewRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/suggest") {
      await handleReviewSuggestRequest(req, res);
      return;
    }

    if (req.method === "POST" && path === "/api/review/suggest/resolve") {
      await handleReviewSuggestResolveRequest(req, res);
      return;
    }

    if (req.method === "GET" && path === "/review/photo") {
      await handleReviewPhotoRequest(req, res);
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
    if (env.DASHBOARD_TOKEN || cfJwks) routes.push("/dashboard", "/review", "/donate");
    const authModes: string[] = [];
    if (cfJwks) authModes.push("cf-access-jwt");
    if (env.DASHBOARD_TOKEN) authModes.push("token");
    console.log(`HTTP server listening on port ${port} (routes: ${routes.join(", ") || "none"}, auth: ${authModes.join("+") || "none"})`);
  });
}

async function start(): Promise<void> {
  // Pre-create the Extraction Traces tab at boot so it's visible in the sheet
  // immediately after deploy, not only after the first invoice runs. Other tabs
  // are pre-existing so we don't need to bootstrap them here.
  try {
    await ensureExtractionTracesHeader();
  } catch (err) {
    console.warn(`ensureExtractionTracesHeader failed at boot: ${(err as Error).message}`);
  }

  try {
    await ensurePromptSuggestionsHeader();
  } catch (err) {
    console.warn(`ensurePromptSuggestionsHeader failed at boot: ${(err as Error).message}`);
  }

  try {
    const rescueKeys = await readRescueDedupeKeys();
    for (const k of rescueKeys) processedRescueKeys.add(k);
    console.log(`Loaded ${rescueKeys.size} existing food_lifeline rescue dedupe key(s).`);
  } catch (err) {
    console.warn(`readRescueDedupeKeys failed at boot: ${(err as Error).message}`);
  }

  if (env.SLACK_APP_TOKEN) {
    await app.start();
    console.log("Slack app started in Socket Mode.");
  } else {
    await app.start(env.SLACK_PORT);
    console.log(`Slack app started on port ${env.SLACK_PORT}.`);
  }

  if (env.VOICE_WEBHOOK_SECRET || env.DASHBOARD_TOKEN || cfJwks) {
    startHttpServer();
  }
}

start().catch((err) => {
  console.error("Failed to start app", err);
  process.exit(1);
});
