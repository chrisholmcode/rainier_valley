/**
 * One-off: re-extract a whiteboard photo and rewrite item_name_raw +
 * item_name_normalized on that message's pre_made_bags rows.
 *
 * Context: prior to this PR, src/extraction.ts unconditionally overrode both
 * name columns on every PMB row with the literal string "pre_made_bags",
 * clobbering the model's per-item names. That was fine for whiteboards where
 * PMB is a single aggregate count, but on itemized PMB sections (e.g.
 * 9/9/2026 slack_message_ts=1788987070.571329) every real item name was lost.
 *
 * Strategy: match by ordinal position within the group. The original
 * appendEodRows write preserved model line-item order, and the re-extraction
 * reads the same photo top-to-bottom, so PMB item N in the fresh extraction
 * corresponds to sheet row N of the (channel, ts, program_type=pre_made_bags)
 * group. Aborts if counts differ.
 *
 * Only touches rows whose item_name_raw is currently "pre_made_bags"
 * (idempotent — safe to re-run).
 *
 * Usage:
 *   npx tsx src/backfill-pmb-item-names.ts <slack_message_ts> <image_path> [--apply]
 */
import { readFileSync } from "fs";
import { basename } from "path";
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { EOD_SHEET_HEADERS } from "./sheets.js";
import { extractFromWhiteboard } from "./extraction.js";

const auth: GoogleAuth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets"] })
  : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets"] });

const sheets: sheets_v4.Sheets = google.sheets({ version: "v4", auth });

function indexToA1(col0: number): string {
  let n = col0;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const targetTs = positional[0];
  const imagePath = positional[1];
  if (!targetTs || !imagePath) {
    console.error("usage: npx tsx src/backfill-pmb-item-names.ts <slack_message_ts> <image_path> [--apply]");
    process.exit(1);
  }

  const lastCol = indexToA1(EOD_SHEET_HEADERS.length - 1);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:${lastCol}`,
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = res.data.values ?? [];
  const idx = new Map(EOD_SHEET_HEADERS.map((h, i) => [h, i]));
  const tsIdx = idx.get("slack_message_ts")!;
  const programIdx = idx.get("program_type")!;
  const rawIdx = idx.get("item_name_raw")!;
  const normIdx = idx.get("item_name_normalized")!;
  const sourceIdx = idx.get("source")!;

  const matches: { rowNumber: number; currentRaw: string }[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const ts = String(r[tsIdx] ?? "");
    if (ts !== targetTs) continue;
    if (String(r[sourceIdx] ?? "") !== "whiteboard") continue;
    if (String(r[programIdx] ?? "") !== "pre_made_bags") continue;
    if (String(r[rawIdx] ?? "") !== "pre_made_bags") continue;
    matches.push({ rowNumber: i + 1, currentRaw: String(r[rawIdx]) });
  }

  console.log(`Found ${matches.length} clobbered PMB rows for ts=${targetTs}`);
  if (matches.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const buf = readFileSync(imagePath);
  const mime = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  const extraction = await extractFromWhiteboard({ imageBytes: buf, mimeType: mime, filename: basename(imagePath) });
  const pmbItems = extraction.line_items.filter((li) => li.program_type === "pre_made_bags");
  console.log(`Re-extraction produced ${pmbItems.length} PMB items`);

  if (pmbItems.length !== matches.length) {
    console.error(`Count mismatch: sheet has ${matches.length} clobbered rows, re-extraction has ${pmbItems.length}. Aborting.`);
    process.exit(2);
  }

  const rawColLetter = indexToA1(rawIdx);
  const normColLetter = indexToA1(normIdx);

  const updates: sheets_v4.Schema$ValueRange[] = [];
  for (let i = 0; i < matches.length; i++) {
    const { rowNumber } = matches[i];
    const item = pmbItems[i];
    const rawName = item.item_name_raw ?? "";
    const normName = item.item_name_normalized ?? "";
    console.log(`  row ${rowNumber}: pre_made_bags → ${rawName} (${normName})`);
    updates.push({ range: `${env.EOD_WORKSHEET_NAME}!${rawColLetter}${rowNumber}`, values: [[rawName]] });
    updates.push({ range: `${env.EOD_WORKSHEET_NAME}!${normColLetter}${rowNumber}`, values: [[normName]] });
  }

  if (!apply) {
    console.log("\nDry-run only. Re-run with --apply to write.");
    return;
  }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    requestBody: {
      valueInputOption: "USER_ENTERED",
      data: updates
    }
  });
  console.log(`\nApplied ${updates.length / 2} row updates.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
