/**
 * One-off: find Inbound Delivery Log rows whose `uploaded_by` is an SRS-rewritten
 * envelope sender ("email:bounces+SRS=...@forwarder.tld") and rewrite them to
 * the decoded original sender. Idempotent — rows that don't match or that
 * already carry a non-SRS address are left alone.
 *
 * Usage:
 *   GOOGLE_WORKSHEET_NAME="Inbound Delivery Log" \
 *     npx tsx --env-file=.env src/backfill-email-srs-attribution.ts [--apply]
 */
import { google, sheets_v4 } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { readDeliveryRows, SHEET_HEADERS } from "./sheets.js";
import { decodeSrsAddress, labelOpaqueSrsBounce } from "./email-intake.js";

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

interface Edit {
  rowNumber: number;
  prev: string;
  next: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`# backfill-email-srs-attribution · mode=${apply ? "APPLY" : "DRY-RUN"}`);

  const rows = await readDeliveryRows({ limit: 20000 });
  console.log(`Delivery rows total: ${rows.length}`);

  const edits: Edit[] = [];
  for (const r of rows) {
    const up = r.uploaded_by ?? "";
    if (!up.startsWith("email:")) continue;
    const addr = up.slice("email:".length);
    const decoded = decodeSrsAddress(addr) ?? labelOpaqueSrsBounce(addr);
    if (!decoded) continue;
    const next = `email:${decoded}`;
    if (next === up) continue;
    edits.push({ rowNumber: r.rowIndex, prev: up, next });
  }

  console.log(`Rewrites planned: ${edits.length}`);
  for (const e of edits.slice(0, 20)) {
    console.log(`  row ${e.rowNumber}  ${e.prev} → ${e.next}`);
  }
  if (edits.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (!apply) {
    console.log("(dry-run — no writes. Re-run with --apply.)");
    return;
  }

  const idx = SHEET_HEADERS.indexOf("uploaded_by");
  if (idx < 0) throw new Error("uploaded_by not in SHEET_HEADERS");
  const col = indexToA1(idx);
  const updates: sheets_v4.Schema$ValueRange[] = edits.map((e) => ({
    range: `${env.GOOGLE_WORKSHEET_NAME}!${col}${e.rowNumber}`,
    values: [[e.next]]
  }));
  const CHUNK = 100;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
      requestBody: { valueInputOption: "RAW", data: chunk }
    });
    console.log(`  wrote batch ${Math.floor(i / CHUNK) + 1}/${Math.ceil(updates.length / CHUNK)} (${chunk.length} cells)`);
  }
  console.log(`Done. ${updates.length} cell(s) updated.`);
}

main().catch((err) => {
  console.error("backfill failed:", (err as Error).message);
  process.exit(1);
});
