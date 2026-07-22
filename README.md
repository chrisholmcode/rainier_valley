# Rainier Valley Food Bank Intake Bot

Slack-first intake bot for RVFB. Staff send photos, PDFs, voice memos, or short text in Slack; the bot uses Claude vision + thinking to extract structured rows, posts a summary in-thread, and writes to Google Sheets. A separate **Review UI** lets a corporate ops reviewer audit low-confidence slips alongside the source photo, edit any field, approve, and feed corrections back into a labeled log for prompt-tuning.

## What it does

Five flows:

- **Inbound deliveries** — staff upload an invoice/manifest (image or PDF). Bot extracts line items + fees, posts a summary, and **auto-writes** to the *Inbound Delivery Log* sheet (if confidence ≥ 75%; below that, nothing is logged and the user is asked to retake the photo). Per-shipment summary row is also appended to the *Inventory Summary* tab for Salesforce.
- **Outbound / whiteboard** — staff upload a photo of the daily whiteboard. Bot extracts items, tags each row by program (`home_delivery`, `in_person_shopping`, `pre_made_bags`), and **auto-writes** to the *Outbound Delivery Log* sheet (same 75% confidence gate).
- **End-of-day inventory** — staff send a Slack text message prefixed with `eod:` *or* upload a voice memo (transcribed via Whisper). Bot stages the extraction in-thread and waits for 👍 to commit (or ❌ to discard). Also reachable as a webhook at `POST /voice` for Alexa-style devices.
- **Assistant `@mentions`** — bot can read recent deliveries and inventory, summarize them, and propose corrections back to the sheets. Corrections are staged and require 👍 to apply.
- **Review UI** — corporate ops reviews every slip in a browser (`/review`). Low-confidence slips surface in a "Needs review" queue at the top; approved + high-confidence slips fall to "Completed". Each slip detail view shows the original photo (Slack-hosted PDFs render via an authed proxy) next to an editable table where every column is editable; edits write back to the sheet, append to a *Corrections Log* tab, and recompute the per-shipment Inventory Summary row.

## Suppliers supported

Vendor-specific extraction rules live in `prompts/invoice/suppliers/`. Each supplier has its own markdown file describing the document layout, column mapping, date/invoice-number conventions, fee handling, and `approx_weight` derivation. Today:

| Supplier slug | Vendor | Acquisition |
|---|---|---|
| `carusos` | Caruso's Produce (Canby, OR) | purchased |
| `charlies` | Charlie's Produce (Seattle, WA) | purchased |
| `costco` | Costco Business Delivery (Fife, WA) | purchased |
| `food_lifeline` | Food Lifeline AGENCY ORDER (printed manifest) | donation |
| `grand_central` | Grand Central Bakery (Seattle, WA) | per-invoice (Customer suffix `- Donation` / `- Purchased`) |
| `grocery_rescue` | Food Lifeline grocery rescue pickups (QFC, Safeway, Homegrown) — donor store captured in `donor_org` | donation |
| `nw_harvest` | Northwest Harvest (Auburn warehouse) | donation |
| `pacific` | Pacific Food Distributors | purchased |
| `terrebonne` | Terrebonne Truck Patch (North Bend, WA) | purchased |
| `weigelt` | The Weigelt Company (North Bend, WA) | purchased |
| `unknown` | Auto-detect from document header | derived |

Donation status is captured per-document via the `is_donation` field on every extraction. Food Lifeline grocery rescue forms also capture the actual donor store (e.g., `QFC-MI`, `Safeway-RB`) in `donor_org`.

## Stack

- Node.js + TypeScript
- [Slack Bolt](https://slack.dev/bolt-js) (Socket Mode for dev)
- Anthropic SDK (`@anthropic-ai/sdk`)
  - Invoice extraction: `claude-opus-4-8` with `effort: xhigh` and adaptive summarized thinking
  - Whiteboard, EOD text, assistant: `claude-sonnet-4-6` (override via `ANTHROPIC_MODEL`)
- OpenAI Whisper for voice memo transcription
- Google Sheets API
- HTTP server (dashboard + review UI + voice webhook)
- Deployed to Railway from `main`; preview PRs go through CODEOWNERS review.

## Local setup

### 1) Install deps

```bash
npm install
```

### 2) Create env file

```bash
cp .env.example .env
```

Fill all required values, including:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
- `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`)
- `OPENAI_API_KEY` (Whisper only)
- `GOOGLE_SPREADSHEET_ID` and either `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`
- `DASHBOARD_TOKEN` — gates both the dashboard and the review UI
- `REVIEW_CONFIDENCE_THRESHOLD` (default `0.75`) — slips with any line item below this and not yet approved land in the review queue

### 3) Create Slack app

Use [api.slack.com/apps](https://api.slack.com/apps):

- Enable **Socket Mode** (recommended for local dev)
- Bot Token Scopes:
  - `app_mentions:read`
  - `channels:history`
  - `channels:read`
  - `chat:write`
  - `files:read`
  - `groups:history`
  - `groups:read`
  - `reactions:read`
- Subscribe to bot events:
  - `app_mention`
  - `message.channels`
  - `message.groups`
  - `reaction_added`
- Install app to workspace
- Copy:
  - `SLACK_BOT_TOKEN` (`xoxb-...`)
  - `SLACK_SIGNING_SECRET`
  - `SLACK_APP_TOKEN` (`xapp-...`, with `connections:write`)

### 4) Create Google Sheet + service account

1. Create a Google Cloud project.
2. Enable Google Sheets API.
3. Create service account key (JSON).
4. Share the target spreadsheet with the service account email as Editor.
5. Set either:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON), or
   - `GOOGLE_APPLICATION_CREDENTIALS` (path to JSON file).

Set spreadsheet ID in `GOOGLE_SPREADSHEET_ID`. The bot creates the *Inbound Delivery Log*, *Outbound Delivery Log*, *Inventory Summary*, and *Corrections Log* worksheets (and their header rows) if missing, and auto-grows the grid `columnCount` when the schema gains new columns.

### 5) Run

```bash
npm run dev
```

Upload an image or PDF in the configured channel. The bot will post a thread summary. React with 👍 to commit rows to the sheet.

## HTTP endpoints

The HTTP server (port from `PORT`, default `3000`) exposes:

### Dashboard

- `GET /dashboard?token=…` — interactive HTML dashboard
  - `view=daily|weekly` (default `daily`)
  - `range=1w|4w` (default `1w`)
  - `program=home_delivery|in_person_shopping|pre_made_bags` (optional, filters outbound)
  - `format=html|csv|raw` (default `html`)
  - `from=YYYY-MM-DD&to=YYYY-MM-DD` (only honored with `format=raw`)

### Review UI

- `GET /review?token=…` — slip-review surface
  - `tab=queue` (default) — two sections: **Needs review** (any line confidence < threshold AND not yet approved, sorted by worst confidence first) and **Completed** (approved or above threshold, most recent first)
  - `tab=history` — single flat list of all slips
- `GET /review/slip?slip=<base64-photo_url>&token=…` — per-slip detail: photo (left) + editable form (right)
  - Slip-level fields cascade to all rows: `supplier`, `document_type`, `delivery_date`, `invoice_or_order_number`, `destination_org`, `donor_org`, `is_donation`
  - Per-row fields edit one row at a time: every line-item column (raw + normalized name, ordered/shipped qty, unit, pack, weight, category, unit cost, line total, fee flag, confidence, notes)
- `GET /review/photo?slip=<base64-photo_url>&token=…` — server-side proxy that fetches the Slack-hosted file with the bot's `Authorization: Bearer SLACK_BOT_TOKEN`. PDFs render via `<iframe>`, images via `<img>`.
- `POST /api/review/edit` — apply one field edit; body `{ slip, row_index, field, new_value, reason? }`. Writes the cell, appends a Corrections Log row, recomputes the Inventory Summary row for the slip, and clears the slip's approval stamps (an edit re-opens the slip).
- `POST /api/review/approve` — stamp `approved_at` / `approved_by` on every row of a slip.

### Voice

- `POST /voice` — Alexa-style webhook for EOD inventory ingestion.

## Google Sheet tabs and columns

### Inbound Delivery Log

Auto-created if missing. New columns are appended on schema changes; the grid grows automatically.

- `created_at` · `supplier` · `document_type` · `delivery_date` · `invoice_or_order_number` · `destination_org`
- `item_code_raw` · `item_name_raw` · `item_name_normalized`
- `quantity_ordered` · `quantity` · `quantity_raw` · `unit` · `pack_size_raw` · `approx_weight` · `category` · `unit_cost` · `line_total`
- `confidence` · `is_fee` · `notes`
- `photo_url` · `slack_channel` · `slack_message_ts` · `uploaded_by` · `warnings_json`
- `donor_org` · `is_donation` · `approved_at` · `approved_by`

### Outbound Delivery Log

Used for both whiteboard outbound and EOD inventory entries.

- `recorded_at` · `date` · `item_name_raw` · `item_name_normalized` · `quantity` · `quantity_raw` · `unit` · `category` · `notes` · `confidence` · `source` (`text` / `voice` / `whiteboard`) · `slack_channel` · `slack_message_ts` · `recorded_by` · `warnings_json` · `program_type`

### Inventory Summary

One row per shipment, recomputed when the live ingest writes new rows AND when the review UI edits an existing slip.

- `created_at` · `delivery_date` · `supplier` · `weight_lb` · `unit` · `invoice_or_order_number` · `food_type` · `is_food` · `cost` · `donation` · `photo_url`

### Corrections Log

Every human edit appends one row. Use this to spot which fields and which suppliers need prompt refinement.

- `timestamp` · `user` · `slip_key` (the photo URL) · `sheet` · `row_index` · `field` · `old_value` · `new_value` · `reason`

## Behavior notes

- Inbound intake accepts image MIME types and `application/pdf`.
- Supplier hint is inferred from message text first, then filename.
- **Confidence gate:** if average extraction confidence is `< 0.75`, photo intake (inbound + whiteboard) is rejected — nothing is logged and the user is asked to retake. Above the threshold, rows are written immediately.
- **What requires 👍:** only EOD inventory (text/voice) and assistant-proposed corrections. Both stage in memory and wait for `reaction_added`:
  - `+1` (👍) commits the staged change.
  - `x` (❌) discards it.
- **What requires Review UI sign-off:** any slip with a line item below the review threshold (`REVIEW_CONFIDENCE_THRESHOLD`, default 0.75) lands in the Needs Review section until a human approves it. Edits re-open the slip.
- **Donation vs purchased** is captured at extraction time via `is_donation`. Food Lifeline grocery rescue forms also write the actual donor store to `donor_org` (e.g., `QFC-MI`, `Safeway-RB`).
- Duplicate-delivery protection (photo intake): dedupes on (supplier + invoice/order number), Slack file ID, and a content hash of the extraction.

## Prompt-change gating

`.github/CODEOWNERS` requires owner review on:

- `prompts/**` — every vendor-specific extraction prompt
- `src/types.ts`, `src/sheets.ts`, `src/extraction.ts` — schema and routing

Branch protection on `main` enforces it. Treat the Corrections Log as the source of truth for which prompts need tightening — when a field is corrected often for one supplier, that's the signal to update that supplier's prompt.

## Reports + utilities

Leadership-facing PDF/HTML rollups are generated by Claude Code skills in `~/.claude/skills`:

- `rvfb-daily-report` — single-day inbound + outbound recap
- `rvfb-weekly-report` — Sunday→Saturday rollup

Both pull from the dashboard's `format=raw` JSON endpoint as their primary source.

One-off scripts in `src/`:

- `backfill-summary.ts` — rebuild Inventory Summary rows from existing Inbound rows (`npm run build && node dist/backfill-summary.js`)
- `backfill-is-donation.ts` — populate `is_donation` for historical rows from the supplier mapping (`npm run backfill:is-donation`)
- `reextract-one.ts` — re-run extraction on a single slip

## Eval harness

`npm test` runs `tests/extraction.spec.ts` against pinned fixtures in `tests/fixtures/`. Each fixture asserts structural facts that should be stable across model versions (supplier classification, line-item count, fee presence, key item-name substrings, totals presence, `is_donation`, `donor_org`). Hits the live Anthropic API — running the full suite costs a few dollars; pre-resize big images (`sips -Z 2000 <file>`) to fit under the 10 MB base64 cap before adding new fixtures.

## Next improvements

- **Persist extraction thinking traces** to a `Extraction Traces` sheet tab so they survive Railway redeploys and are linkable from the review UI.
- **Product normalization dictionary** in a Sheets `Products` tab (today, normalization is hardcoded supplier-by-supplier).
- **Branch-protect main** in the GitHub UI to make CODEOWNERS enforced rather than advisory.
