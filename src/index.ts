import { createHash } from "crypto";
import axios from "axios";
import { App } from "@slack/bolt";
import { env } from "./config.js";
import { appendExtractionRows, ensureSheetHeader, appendEodRows, ensureEodSheetHeader, updateSheetCell } from "./sheets.js";
import { extractFromImage, extractFromText, transcribeAudio, guessSupplierFromFilename } from "./extraction.js";
import { runAssistantLoop } from "./assistant.js";
import type { ExtractionResult, EodExtractionResult, Supplier, ThreadHistory, PendingAssistantCorrection } from "./types.js";

interface PendingFileExtraction {
  fileId: string;
  contentHash: string;
  fileName: string;
  photoUrl: string;
  extraction: ExtractionResult;
}

interface PendingDelivery {
  rootKey: string;
  channel: string;
  rootMessageTs: string;
  uploadedBy: string;
  files: PendingFileExtraction[];
  createdAt: string;
}

const pendingDeliveries = new Map<string, PendingDelivery>();
const messageKeyToRootKey = new Map<string, string>();
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
    `📋 *EOD Inventory — ${extraction.date ?? "today"}*\n` +
    `${lines.join("\n")}\n\n` +
    `React 👍 to save to Google Sheets\nReact ❌ to discard` +
    warnings
  );
}

function pendingKey(channel: string, ts: string): string {
  return `${channel}:${ts}`;
}

function clearPending(rootKey: string): void {
  pendingDeliveries.delete(rootKey);
  for (const [key, value] of messageKeyToRootKey.entries()) {
    if (value === rootKey) {
      messageKeyToRootKey.delete(key);
    }
  }
}

function summarizePending(pending: PendingDelivery): {
  lineItems: number;
  fees: number;
  avgConfidence: number;
} {
  let lineItems = 0;
  let fees = 0;
  let totalConfidence = 0;
  for (const f of pending.files) {
    lineItems += f.extraction.line_items.length;
    fees += f.extraction.fees.length;
    for (const li of f.extraction.line_items) {
      totalConfidence += li.confidence;
    }
  }
  const avgConfidence = lineItems > 0 ? Math.round((totalConfidence / lineItems) * 100) : 0;
  return { lineItems, fees, avgConfidence };
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

    const startMsg = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Received ${files.length} file(s). Starting extraction...`
    });

    const rootKey = pendingKey(message.channel, message.ts);
    const pending: PendingDelivery = {
      rootKey,
      channel: message.channel,
      rootMessageTs: message.ts,
      uploadedBy: message.user || "unknown",
      files: [],
      createdAt: new Date().toISOString()
    };

    for (const file of files) {
      if (!file.url_private_download) continue;

      const buffer = await downloadSlackFile(file.url_private_download);
      const contentHash = createHash("sha256").update(buffer).digest("hex");

      if (processedContentHashes.has(contentHash)) {
        console.log(`Skipping file ${file.name} — content already processed (hash: ${contentHash.slice(0, 12)}…)`);
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

      pending.files.push({
        fileId: file.id,
        contentHash,
        fileName: file.name,
        photoUrl: file.url_private_download,
        extraction
      });
    }

    if (!pending.files.length) {
      console.log("All files were duplicates, skipping");
      return;
    }

    pendingDeliveries.set(rootKey, pending);
    messageKeyToRootKey.set(rootKey, rootKey);
    if (startMsg.ts) {
      messageKeyToRootKey.set(pendingKey(message.channel, startMsg.ts), rootKey);
    }

    const summary = summarizePending(pending);
    const confidenceEmoji = summary.avgConfidence >= 90 ? "🟢" : summary.avgConfidence >= 75 ? "🟡" : "🔴";
    const summaryMsg = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text:
        `📦 *Extraction ready for review*\n` +
        `Files: *${pending.files.length}* | Line items: *${summary.lineItems}* | Fees: *${summary.fees}*\n` +
        `${confidenceEmoji} Confidence: *${summary.avgConfidence}%*\n\n` +
        `React 👍 to confirm and write to Google Sheets\n` +
        `React ❌ to discard`
    });
    if (summaryMsg.ts) {
      messageKeyToRootKey.set(pendingKey(message.channel, summaryMsg.ts), rootKey);
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
    const rootKey = messageKeyToRootKey.get(lookupKey) || lookupKey;
    console.log(`LookupKey: ${lookupKey}, RootKey: ${rootKey}`);
    console.log(`Pending deliveries keys:`, Array.from(pendingDeliveries.keys()));

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

    const pending = pendingDeliveries.get(rootKey);
    if (!pending) {
      console.log("No pending delivery found for this reaction");
      return;
    }

    console.log("Found pending delivery, processing...");

    if (reaction === "+1") {
      console.log("Processing +1 reaction - writing to Google Sheets...");
      for (const file of pending.files) {
        processedFileIds.add(file.fileId);
        processedContentHashes.add(file.contentHash);
        if (file.extraction.invoice_or_order_number && file.extraction.supplier !== "unknown") {
          processedInvoiceKeys.add(`${file.extraction.supplier}:${file.extraction.invoice_or_order_number}`);
        }
      }
      processedMessageKeys.add(pending.rootKey);
      clearPending(rootKey);

      try {
        await ensureSheetHeader();
        console.log("Sheet header ensured");

        let totalRows = 0;
        for (const file of pending.files) {
          console.log(`Writing rows for file: ${file.fileName}`);
          const rowsAdded = await appendExtractionRows({
            extraction: file.extraction,
            photoUrl: file.photoUrl,
            slackChannel: pending.channel,
            slackMessageTs: pending.rootMessageTs,
            uploadedBy: pending.uploadedBy
          });
          totalRows += rowsAdded;
          console.log(`Wrote ${rowsAdded} rows`);
        }

        console.log(`Total rows written: ${totalRows}`);
        await client.chat.postMessage({
          channel: pending.channel,
          thread_ts: pending.rootMessageTs,
          text: `✅ Confirmed by <@${event.user}>. Wrote *${totalRows}* row(s) to Google Sheets.`
        });
      } catch (sheetsError) {
        console.error("Google Sheets error:", sheetsError);
        await client.chat.postMessage({
          channel: pending.channel,
          thread_ts: pending.rootMessageTs,
          text: `❌ Error writing to Google Sheets: ${(sheetsError as Error).message}`
        });
      }
      return;
    }

    if (reaction === "x") {
      clearPending(rootKey);
      await client.chat.postMessage({
        channel: pending.channel,
        thread_ts: pending.rootMessageTs,
        text: `Discarded by <@${event.user}>. No rows were written.`
      });
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

async function start(): Promise<void> {
  if (env.SLACK_APP_TOKEN) {
    await app.start();
    console.log("Slack app started in Socket Mode.");
  } else {
    await app.start(env.SLACK_PORT);
    console.log(`Slack app started on port ${env.SLACK_PORT}.`);
  }
}

start().catch((err) => {
  console.error("Failed to start app", err);
  process.exit(1);
});
