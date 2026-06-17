# Rainier Valley Food Bank Intake Bot

Slack-first intake bot for RVFB. Staff send photos, PDFs, voice memos, or short text in Slack; the bot uses Claude vision + thinking to extract structured rows, posts a summary in-thread, and writes to Google Sheets after a 👍. An HTTP dashboard exposes daily/weekly rollups (HTML, CSV, or raw JSON), and an `@mention` assistant can answer questions and propose corrections against the sheets.

## What it does

Three intake flows, all gated by a 👍 reaction before any write:

- **Inbound deliveries** — staff upload an invoice/manifest (image or PDF). Bot extracts line items + fees, posts a summary, writes to the *Inbound Delivery Log* sheet on 👍.
- **Outbound / whiteboard** — staff upload a photo of the daily whiteboard. Bot extracts items and tags each row by program (`home_delivery`, `in_person_shopping`, `pre_made_bags`). Writes to the *Outbound Delivery Log* sheet on 👍.
- **End-of-day inventory** — staff send a Slack text message prefixed with `eod:` *or* upload a voice memo (transcribed via Whisper). Also reachable as a webhook at `POST /voice` for Alexa-style devices.

The bot also responds to `@mentions`: it can read recent deliveries and inventory, summarize them, and propose corrections back to the sheets (corrections also require 👍 to apply).

## Stack

- Node.js + TypeScript
- [Slack Bolt](https://slack.dev/bolt-js) (Socket Mode for dev)
- Anthropic SDK (`@anthropic-ai/sdk`)
  - Invoice extraction: `claude-opus-4-8` with `effort: xhigh` and adaptive summarized thinking
  - Whiteboard, EOD text, assistant: `claude-sonnet-4-6` (override via `ANTHROPIC_MODEL`)
- OpenAI Whisper for voice memo transcription
- Google Sheets API
- Express HTTP server (dashboard + voice webhook)

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
- `DASHBOARD_TOKEN` for the dashboard URL

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

Set spreadsheet ID in `GOOGLE_SPREADSHEET_ID`. The bot creates the *Inbound Delivery Log* and *Outbound Delivery Log* worksheets (and their header rows) if missing.

### 5) Run

```bash
npm run dev
```

Upload an image or PDF in the configured channel. The bot will post a thread summary. React with 👍 to commit rows to the sheet.

## HTTP endpoints

The Express server (port from `PORT`, default `3000`) exposes:

- `GET /dashboard?token=…` — interactive HTML dashboard
  - `view=daily|weekly` (default `daily`)
  - `range=1w|4w` (default `1w`)
  - `program=home_delivery|in_person_shopping|pre_made_bags` (optional, filters outbound)
  - `format=html|csv|raw` (default `html`)
  - `from=YYYY-MM-DD&to=YYYY-MM-DD` (only honored with `format=raw`)
- `POST /voice` — Alexa-style webhook for EOD inventory ingestion

## Google Sheet columns

### Inbound Delivery Log

Auto-created if missing:

- `created_at`
- `supplier`
- `document_type`
- `delivery_date`
- `invoice_or_order_number`
- `destination_org`
- `item_code_raw`
- `item_name_raw`
- `item_name_normalized`
- `quantity_ordered`
- `quantity`
- `quantity_raw`
- `unit`
- `pack_size_raw`
- `approx_weight`
- `category`
- `unit_cost`
- `line_total`
- `confidence`
- `is_fee`
- `notes`
- `photo_url`
- `slack_channel`
- `slack_message_ts`
- `uploaded_by`
- `warnings_json`

### Outbound Delivery Log

Used for both whiteboard outbound and EOD inventory entries:

- `recorded_at`
- `date`
- `item_name_raw`
- `item_name_normalized`
- `quantity`
- `quantity_raw`
- `unit`
- `category`
- `notes`
- `confidence`
- `source` (`text`, `voice`, or `whiteboard`)
- `slack_channel`
- `slack_message_ts`
- `recorded_by`
- `warnings_json`
- `program_type`

## Behavior notes

- Inbound intake accepts image MIME types and `application/pdf`.
- Supplier hint is inferred from message text first, then filename.
- Low-confidence item count (`< 0.75`) is surfaced in the Slack thread.
- Staged extractions live in memory until a `reaction_added` event:
  - `+1` (👍) commits rows to the sheet.
  - `x` (❌) discards the staged extraction.
- Duplicate-delivery protection: dedupes on (supplier + invoice/order number), Slack file ID, and a content hash of the staged extraction.
- Assistant corrections (`@bot fix yesterday's romaine to 10`) are also staged and require 👍 before they're written.

## Reports

Leadership-facing PDF/HTML rollups are generated by Claude Code skills in `~/.claude/skills`:

- `rvfb-daily-report` — single-day inbound + outbound recap
- `rvfb-weekly-report` — Sunday→Saturday rollup

Both pull from the dashboard's `format=raw` JSON endpoint as their primary source.

## Next improvements

- Product normalization dictionary in a Sheets `Products` tab (today, normalization is hardcoded supplier-by-supplier).
