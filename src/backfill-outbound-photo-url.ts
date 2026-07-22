/**
 * One-off: backfill photo_url on historical whiteboard rows in the Outbound
 * Delivery Log. These rows were written before the photo_url column existed
 * (added 2026-07-17 in commit e5419db), so the Review UI can't render their
 * photos.
 *
 * Strategy: group rows by (slack_channel, slack_message_ts), fetch each
 * parent message via conversations.history, take the first image file's
 * url_private_download, and stamp column S on every row in that group.
 *
 * Idempotent: skips any row that already has a photo_url. Only touches
 * source=whiteboard rows.
 *
 * Usage:
 *   npx tsx src/backfill-outbound-photo-url.ts [--apply]
 *
 *   Without --apply, prints a dry-run summary. With --apply, writes.
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { WebClient } from "@slack/web-api";
import { env } from "./config.js";
import { EOD_SHEET_HEADERS } from "./sheets.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });
const slack = new WebClient(env.SLACK_BOT_TOKEN);

function indexToA1(col0: number): string {
  let n = col0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

interface SlackFileLike {
  mimetype?: string;
  url_private_download?: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`Backfill outbound photo_url (${apply ? "APPLY" : "dry-run"})`);

  const lastCol = indexToA1(EOD_SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:${lastCol}`,
    // Sheets auto-typed slack_message_ts as a number and DISPLAYS only the
    // integer portion — we need the underlying float to recover microseconds.
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values ?? [];
  const idx = new Map(EOD_SHEET_HEADERS.map((h, i) => [h, i]));
  const sourceIdx = idx.get("source")!;
  const channelIdx = idx.get("slack_channel")!;
  const tsIdx = idx.get("slack_message_ts")!;
  const photoIdx = idx.get("photo_url")!;

  // Some historical rows stored ts as milliseconds (13-digit integer) instead
  // of the seconds-with-microseconds float Slack actually emits. Normalize.
  function tsToSeconds(raw: unknown): number | null {
    if (raw == null || raw === "") return null;
    const n = typeof raw === "number" ? raw : Number(String(raw));
    if (!Number.isFinite(n)) return null;
    return n > 1e12 ? n / 1000 : n;
  }

  interface Group {
    channel: string;
    tsSec: number;
    rowNumbers: number[];
  }
  const groups = new Map<string, Group>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[sourceIdx] ?? "") !== "whiteboard") continue;
    const photoCell = r[photoIdx];
    if (photoCell != null && String(photoCell).trim()) continue;
    const channel = String(r[channelIdx] ?? "");
    const tsSec = tsToSeconds(r[tsIdx]);
    if (!channel || tsSec === null) continue;
    const key = `${channel}:${tsSec.toFixed(5)}`;
    let g = groups.get(key);
    if (!g) {
      g = { channel, tsSec, rowNumbers: [] };
      groups.set(key, g);
    }
    g.rowNumbers.push(i + 1);
  }

  const totalRows = [...groups.values()].reduce((a, g) => a + g.rowNumbers.length, 0);
  console.log(`Whiteboard rows missing photo_url: ${totalRows}`);
  console.log(`Unique parent messages: ${groups.size}`);

  interface Plan {
    channel: string;
    ts: string;
    photoUrl: string;
    rowNumbers: number[];
  }
  const plans: Plan[] = [];
  const missing: { channel: string; ts: string; reason: string; rows: number }[] = [];
  let processed = 0;
  for (const g of groups.values()) {
    processed++;
    // Widen the window by ±5 seconds — Sheets truncated the ts to ~5 decimals
    // of precision, so an exact match won't hit. In a low-volume inventory
    // channel a 10-second window is very unlikely to collide with another
    // photo upload.
    const oldest = (g.tsSec - 5).toFixed(6);
    const latest = (g.tsSec + 5).toFixed(6);
    const tsLabel = g.tsSec.toFixed(6);
    try {
      const resp = await slack.conversations.history({
        channel: g.channel,
        latest,
        oldest,
        inclusive: true,
        limit: 20
      });
      const msgs = (resp.messages ?? []) as { ts?: string; files?: SlackFileLike[] }[];
      // Pick the message closest to our ts that has at least one image file.
      const scored = msgs
        .filter((m) => Array.isArray(m.files) && m.files.some((f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/") && !!f.url_private_download))
        .map((m) => ({ m, dt: Math.abs(Number(m.ts) - g.tsSec) }))
        .sort((a, b) => a.dt - b.dt);
      const best = scored[0]?.m;
      if (!best) {
        missing.push({ channel: g.channel, ts: tsLabel, reason: "no image-bearing message in ±5s window (likely deleted from Slack)", rows: g.rowNumbers.length });
        continue;
      }
      const imgFile = (best.files ?? []).find(
        (f) => typeof f.mimetype === "string" && f.mimetype.startsWith("image/") && !!f.url_private_download
      );
      if (!imgFile?.url_private_download) {
        missing.push({ channel: g.channel, ts: tsLabel, reason: "no image file on message", rows: g.rowNumbers.length });
        continue;
      }
      plans.push({ channel: g.channel, ts: tsLabel, photoUrl: imgFile.url_private_download, rowNumbers: g.rowNumbers });
    } catch (err) {
      missing.push({ channel: g.channel, ts: tsLabel, reason: `slack error: ${(err as Error).message}`, rows: g.rowNumbers.length });
    }
    if (processed % 10 === 0) console.log(`  fetched ${processed}/${groups.size}`);
    // Gentle Tier-3 (~50/min) rate-limit pacing.
    await new Promise((r) => setTimeout(r, 300));
  }

  const resolvedRows = plans.reduce((a, p) => a + p.rowNumbers.length, 0);
  console.log(`\nResolved: ${plans.length} messages (${resolvedRows} rows)`);
  console.log(`Unresolved: ${missing.length} messages (${missing.reduce((a, m) => a + m.rows, 0)} rows)`);
  for (const m of missing.slice(0, 20)) {
    console.log(`  ${m.channel}/${m.ts}  rows=${m.rows}  — ${m.reason}`);
  }
  if (missing.length > 20) console.log(`  … +${missing.length - 20} more`);

  if (plans.length === 0) {
    console.log("Nothing to write.");
    return;
  }
  if (!apply) {
    console.log("\nDry-run — re-run with --apply to write.");
    return;
  }

  const photoCol = indexToA1(photoIdx);
  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (const p of plans) {
    for (const rowNumber of p.rowNumbers) {
      updates.push({ range: `${env.EOD_WORKSHEET_NAME}!${photoCol}${rowNumber}`, values: [[p.photoUrl]] });
    }
  }
  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: chunk }
    });
    console.log(`  wrote ${Math.min(i + CHUNK, updates.length)}/${updates.length} cell updates`);
  }
  console.log(`\nDone.`);
}

main().catch((err) => {
  console.error("backfill-outbound-photo-url failed:", err);
  process.exit(1);
});
