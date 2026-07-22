/**
 * Sheets-level smoke check for the Review UI. Catches the class of bug
 * where a schema addition ships but the review UI ends up showing an
 * empty state because writes silently regressed (photo_url on
 * whiteboards, PR #19) or a numeric column got coerced by Sheets
 * (slack_message_ts, PR #33).
 *
 * Exits non-zero on any violation. Cheap: one Sheets read, no HTTP.
 *
 * Usage:
 *   npm run smoke
 */
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";
import { env } from "./config.js";
import { EOD_SHEET_HEADERS } from "./sheets.js";

const RECENT_DAYS = 7;

// Grandfather clauses — rows written before each fix landed are exempt from
// the invariant that fix enforces. Bumps to these are one-line edits; each
// corresponds to the merge time of the PR that established the invariant.
const PHOTO_URL_FIX_AT = "2026-07-17T18:16:38Z"; // PR #19 (e5419db)
const TS_TEXT_FIX_AT   = "2026-07-22T03:52:32Z"; // PR #33 (84a9657)

async function main(): Promise<void> {
  const auth = env.GOOGLE_SERVICE_ACCOUNT_JSON
    ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] })
    : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.EOD_WORKSHEET_NAME}!A:S`,
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = (res.data.values ?? []).slice(1);
  const idx = new Map(EOD_SHEET_HEADERS.map((h, i) => [h, i]));
  const sourceIdx = idx.get("source")!;
  const recordedAtIdx = idx.get("recorded_at")!;
  const photoIdx = idx.get("photo_url")!;
  const tsIdx = idx.get("slack_message_ts")!;
  const recentCutoff = new Date(Date.now() - RECENT_DAYS * 86400_000).toISOString();
  const photoCutoff = recentCutoff > PHOTO_URL_FIX_AT ? recentCutoff : PHOTO_URL_FIX_AT;
  const tsCutoff = recentCutoff > TS_TEXT_FIX_AT ? recentCutoff : TS_TEXT_FIX_AT;

  const failures: string[] = [];

  // Invariant 1 (regression guard for PR #19): every whiteboard row written
  // after the fix landed must have a non-empty photo_url. If this fires,
  // the write path stopped capturing url_private_download.
  const missingPhoto = rows.filter((r) =>
    String(r[sourceIdx] ?? "") === "whiteboard" &&
    String(r[recordedAtIdx] ?? "") >= photoCutoff &&
    !String(r[photoIdx] ?? "").trim()
  );
  if (missingPhoto.length) {
    failures.push(`${missingPhoto.length} whiteboard rows since ${photoCutoff} without photo_url (regression from PR #19)`);
  }

  // Invariant 2 (regression guard for PR #33): slack_message_ts must be
  // stored as text so Sheets doesn't coerce and truncate precision. After
  // PR #33 the API returns these as strings — a number here means the
  // apostrophe-prefix escape got dropped somewhere.
  const numericTs = rows.filter((r) =>
    String(r[recordedAtIdx] ?? "") >= tsCutoff &&
    r[tsIdx] != null &&
    r[tsIdx] !== "" &&
    typeof r[tsIdx] === "number"
  );
  if (numericTs.length) {
    failures.push(`${numericTs.length} rows since ${tsCutoff} with numeric slack_message_ts (regression from PR #33 — should be text)`);
  }

  if (failures.length) {
    console.error("SMOKE FAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`SMOKE OK: all invariants pass over the last ${RECENT_DAYS} days (${rows.length} rows scanned)`);
}

main().catch((err) => { console.error("smoke check failed:", err); process.exit(1); });
