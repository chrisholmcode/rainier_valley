# Rainier Valley Food Bank Intake Bot (Slack -> Vision -> Google Sheets)

This service listens for image uploads in Slack, extracts delivery line items from documents/photos, then appends records to a Google Sheet after human confirmation.

## What it does

1. Staff uploads delivery docs/photos to a Slack channel.
2. Bot downloads the file from Slack.
3. Bot runs vision extraction using OpenAI.
4. Bot posts an extraction summary in-thread and waits for confirmation.
5. Staff reacts with 👍 to confirm write, or ❌ to discard.
6. On 👍, bot appends line items and fees into Google Sheets.

## Stack

- Node.js + TypeScript
- [Slack Bolt](https://slack.dev/bolt-js)
- OpenAI Responses API (vision)
- Google Sheets API

## Local setup

## 1) Install deps

```bash
npm install
```

## 2) Create env file

```bash
cp .env.example .env
```

Fill all required values.

## 3) Create Slack app

Use [api.slack.com/apps](https://api.slack.com/apps):

- Enable **Socket Mode** (recommended for local dev)
- Add Bot Token Scopes:
  - `channels:history`
  - `channels:read`
  - `chat:write`
  - `files:read`
  - `groups:history`
  - `groups:read`
  - `reactions:read`
- Subscribe to bot events:
  - `message.channels`
  - `message.groups`
  - `reaction_added`
- Install app to workspace
- Copy:
  - `SLACK_BOT_TOKEN` (`xoxb-...`)
  - `SLACK_SIGNING_SECRET`
  - `SLACK_APP_TOKEN` (`xapp-...`, with `connections:write`)

## 4) Create Google Sheet + service account

1. Create a Google Cloud project.
2. Enable Google Sheets API.
3. Create service account key (JSON).
4. Share the target spreadsheet with the service account email as Editor.
5. Set either:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON), or
   - `GOOGLE_APPLICATION_CREDENTIALS` (path to JSON file).

Set spreadsheet ID in `GOOGLE_SPREADSHEET_ID`.

## 5) Run

```bash
npm run dev
```

Upload an image in the configured channel. The bot will post a thread summary. React with 👍 to commit rows to the sheet.

## Google Sheet columns

The app auto-creates header row if missing:

- `created_at`
- `supplier`
- `document_type`
- `delivery_date`
- `invoice_or_order_number`
- `destination_org`
- `item_code_raw`
- `item_name_raw`
- `item_name_normalized`
- `quantity`
- `quantity_raw`
- `unit`
- `pack_size_raw`
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

## Behavior notes

- Processes only `file_share` message events.
- Supports image MIME types.
- Supplier hint is inferred from message text first, then filename.
- Low-confidence item count (`< 0.75`) is reported in Slack thread.
- Data is staged in-memory until a `reaction_added` event with `+1` (👍).
- `x` (❌) discards the staged extraction and writes nothing.

## Next improvements

- Add correction parser (`"romaine should be 10"`) and write back adjustments.
- Add duplicate-delivery protection by message ID + file ID hash.
- Add product normalization dictionary in Sheets `Products` tab.
