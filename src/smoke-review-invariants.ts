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
import "dotenv/config";
import { google } from "googleapis";
import { GoogleAuth } from "google-auth-library";

// Read env directly rather than through config.ts — config.ts strict-parses
// the whole app schema (Slack tokens, Anthropic key, etc.) at import time,
// and smoke needs to run in CI with just the three Sheets vars.
const {
  GOOGLE_SERVICE_ACCOUNT_JSON,
  GOOGLE_SPREADSHEET_ID,
  EOD_WORKSHEET_NAME = "Outbound Delivery Log"
} = process.env;
if (!GOOGLE_SPREADSHEET_ID) {
  // Self-skip when unconfigured. This is the "workflow armed but repo
  // secrets not yet set" state — exit 0 so we don't spam failure emails.
  // Once secrets land, the real invariant checks kick in automatically.
  console.log("smoke: SKIP (GOOGLE_SPREADSHEET_ID not set — set repo secrets to arm)");
  process.exit(0);
}

const RECENT_DAYS = 7;

// Grandfather clauses — rows written before each fix landed are exempt from
// the invariant that fix enforces. Bumps to these are one-line edits; each
// corresponds to the merge time of the PR that established the invariant.
const PHOTO_URL_FIX_AT = "2026-07-17T18:16:38Z"; // PR #19 (e5419db)
const TS_TEXT_FIX_AT   = "2026-07-22T03:52:32Z"; // PR #33 (84a9657)

async function main(): Promise<void> {
  const auth = GOOGLE_SERVICE_ACCOUNT_JSON
    ? new GoogleAuth({ credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] })
    : new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"] });
  const sheets = google.sheets({ version: "v4", auth });
  // Fetch the header row + data separately so column indices resolve by name
  // (resistant to any future EOD_SHEET_HEADERS reorder) without pulling the
  // whole app's env-dependent import graph in.
  const headerRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: `${EOD_WORKSHEET_NAME}!1:1`
  });
  const headers = (headerRes.data.values?.[0] ?? []) as string[];
  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SPREADSHEET_ID,
    range: `${EOD_WORKSHEET_NAME}!A2:AZ`,
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const rows = dataRes.data.values ?? [];
  const idx = new Map(headers.map((h, i) => [h, i]));
  const required = ["source", "recorded_at", "photo_url", "slack_message_ts"] as const;
  for (const col of required) {
    if (!idx.has(col)) {
      console.error(`smoke: column "${col}" not found in ${EOD_WORKSHEET_NAME} header — schema drift?`);
      process.exit(1);
    }
  }
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
