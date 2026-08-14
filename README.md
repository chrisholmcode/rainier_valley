# Loadslip (Rainier Valley Food Bank intake bot)

Slack-first, email-second, web-third intake for a food bank's inventory. Staff photograph invoices in Slack, forward vendor emails to `invoices@loadslip.com`, or drag files into a browser upload. Claude vision + thinking extracts structured rows and writes to Google Sheets. A browser **Review UI** lets ops audit low-confidence slips alongside the source photo, edit any field, approve, and feed corrections into a labeled log that drives prompt improvements.

Originally built for Rainier Valley Food Bank; now multi-tenant (same code powers the Edmonds Food Bank pilot at `edmonds.loadslip.com`).

## What it does

**Intake surfaces:**

- **Slack file share** — staff drop a photo/PDF in the configured channel. Extracts, posts a summary in-thread, and (if avg confidence ≥ 0.7) auto-writes.
- **Email** — vendors send invoices to `billing@rvfb.org`; a Gmail filter forwards them to `invoices@loadslip.com`. A Cloudflare Email Worker verifies SPF/DKIM + sender allowlist, HMAC-signs the payload, and POSTs to `/api/inbound-email`. Same extraction pipeline as Slack.
- **Web bulk upload** (`/review/upload`) — mobile-friendly page for photographing a stack of slips off Slack. Multi-file, image or PDF, up to 25 MB each.
- **Grocery Rescue XLSX** (`/grocery-rescue/upload`) — parses the RVFB monthly workbook (one tab per month, per-category pound totals) directly into the sheet without running vision on individual slips.
- **Whiteboard photo (Slack)** — daily outbound whiteboard. Extracted per row, tagged `home_delivery` / `in_person_shopping` / `pre_made_bags`.
- **EOD text / voice (Slack)** — `eod: …` messages or voice memos (Whisper transcribed). Stages in-thread, requires 👍 to commit.
- **Voice webhook** (`POST /voice`) — Alexa-style HMAC-signed webhook for hands-free EOD.
- **`@mention` assistant** — reads recent deliveries + inventory, proposes corrections back to the sheets; staged, requires 👍.

**Review + observability:**

- **Review UI** (`/review`) — inbound + outbound queues. Low-confidence slips surface first; approved/high-confidence fall to the completed list. Each slip detail view shows the source photo (via authed proxy) next to an editable table. Every column is editable; edits write back, append to Corrections Log, recompute the Inventory Summary row, and re-open the slip.
- **Reviewer suggestions** (`/review/slip` → suggestion box) — reviewers propose prompt improvements in natural language; admin approves/rejects at `/review?tab=suggestions`.
- **Agent-tuner** (`.github/workflows/prompt-tuner.yml`, daily cron) — reads Corrections Log, clusters by `supplier × field`, asks Claude for minimal per-supplier prompt edits, files suggestions and/or opens PRs. CODEOWNERS still gates the merge.
- **Dashboard** (`/dashboard`) — daily/weekly inbound-in-pounds + outbound-by-program charts.
- **Skills** — `rvfb-daily-report` and `rvfb-weekly-report` (`~/.claude/skills/`) render leadership-facing HTML + PDF from the dashboard's raw JSON.

## Suppliers supported

Vendor-specific extraction rules live in `prompts/invoice/suppliers/<slug>.md`. Each file describes document layout, column mapping, date/invoice-number conventions, fee handling, and `approx_weight` derivation.

| Supplier slug | Vendor | Acquisition |
|---|---|---|
| `carusos` | Caruso's Produce (Canby, OR) | purchased |
| `charlies` | Charlie's Produce (Seattle, WA) | purchased |
| `costco` | Costco Business Delivery (Fife, WA) | purchased |
| `food_lifeline` | Food Lifeline AGENCY ORDER (printed manifest) | donation |
| `grand_central` | Grand Central Bakery (Seattle, WA) | per-invoice (Customer suffix `- Donation` / `- Purchased`) |
| `grocery_rescue` | Food Lifeline grocery rescue pickups (QFC, Safeway, Homegrown) — donor store in `donor_org` | donation |
| `hayton_farms` | Hayton Farms Berries (Mount Vernon, WA) via Growing for Good | donation |
| `nw_harvest` | Northwest Harvest (Auburn warehouse) | donation |
| `pacific` | Pacific Food Distributors | purchased |
| `terrebonne` | Terrebonne Truck Patch (North Bend, WA) | purchased |
| `weigelt` | The Weigelt Company (North Bend, WA) — halal meat/poultry | purchased |
| `unknown` | Auto-detect from document header | derived |

Donation status is captured per-document via `is_donation`. Food Lifeline grocery rescue rows also carry the donor store (`QFC-MI`, `SWY-RB`, etc.) in `donor_org`.

## Multi-tenant

`TENANT_NAME` and `TENANT_SHORT` env vars scope branding and defaults. RVFB is the default (backwards compatible). Edmonds runs the same code as a separate Railway service with `TENANT_NAME="Edmonds Food Bank"` / `TENANT_SHORT="Edmonds"` and its own Google Sheet, Slack workspace, and custom domain (`edmonds.loadslip.com`). See `project_edmonds_pilot_week1.md` in the private notes for the onboarding playbook.

## Stack

- Node 22, TypeScript (ESM), `tsx` for dev
- `@slack/bolt` v4 in Socket Mode
- `@anthropic-ai/sdk` — invoice extraction uses `claude-opus-4-8` with adaptive summarized thinking; whiteboard / EOD / assistant use `claude-sonnet-4-6` (`ANTHROPIC_MODEL` override)
- OpenAI Whisper for voice memo transcription
- `googleapis` Sheets API v4 via a service account
- `xlsx` for Grocery Rescue workbook parsing
- `@aws-sdk/client-s3` — talks to Cloudflare **R2** for durable slip-photo storage (S3-compatible protocol; no AWS involved)
- `jose` for Cloudflare Access JWT verification
- `node:http` server (no Express) on `PORT` or `VOICE_PORT`; auth is CF Access JWT preferred with `DASHBOARD_TOKEN` fallback
- `zod` at every process boundary

## Local setup

### 1) Install deps

```bash
npm install
```

### 2) Create env file

```bash
cp .env.example .env
```

Required for a minimal local run:

- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN`
- `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`)
- `OPENAI_API_KEY` (voice memos only)
- `GOOGLE_SPREADSHEET_ID` + one of `GOOGLE_SERVICE_ACCOUNT_JSON` (inline) or `GOOGLE_APPLICATION_CREDENTIALS` (path)
- One of `DASHBOARD_TOKEN` (simple token in `?token=` query param) or `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD_TAG` (JWT auth for prod)

Optional but production-relevant:

- `TENANT_NAME`, `TENANT_SHORT` — branding (default RVFB)
- `REVIEW_CONFIDENCE_THRESHOLD` — default `0.75`; slips with any line below this land in the review queue
- `EMAIL_INTAKE_SECRET`, `EMAIL_ALLOWED_SENDERS` — enables `POST /api/inbound-email`; both required
- `EMAIL_HEARTBEAT_VENDORS` — CSV of `pattern:staleDays` (e.g., `@charlies-produce.com:10`) for silent-breakage alerts to `ADMIN_SLACK_USER_ID`
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET` — durable slip-photo storage. Without R2 configured, photos fall back to in-memory (24h TTL, wiped on restart).
- `VOICE_WEBHOOK_SECRET`, `VOICE_PORT` — enables `POST /voice`
- `ADMIN_SLACK_USER_ID`, `ADMIN_EMAIL` — reviewer suggestion DMs + admin permissions

### 3) Create Slack app

At [api.slack.com/apps](https://api.slack.com/apps), enable **Socket Mode**, add bot scopes (`app_mentions:read`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `groups:history`, `groups:read`, `reactions:read`), subscribe to events (`app_mention`, `message.channels`, `message.groups`, `reaction_added`), install to workspace, copy tokens into `.env`.

### 4) Create Google Sheet + service account

Standard GCP flow: create project → enable Sheets API → create service-account key JSON → share the target spreadsheet with the service-account email as **Editor**. Set the sheet ID in `GOOGLE_SPREADSHEET_ID`. The bot auto-creates missing tabs (Inbound/Outbound Delivery Log, Inventory Summary, Corrections Log, Extraction Traces, Prompt Suggestions, Processed Emails, Crates) and auto-grows the grid `columnCount` as `SHEET_HEADERS` gains columns.

### 5) Run

```bash
npm run dev
```

Upload an image or PDF in the configured Slack channel; the bot posts a summary. React 👍 to commit staged EOD/text/voice rows.

## HTTP endpoints

Auth: **CF Access JWT** if `CF_ACCESS_*` configured (preferred), else `?token=<DASHBOARD_TOKEN>` fallback. `/api/inbound-email` is unwrapped from `authRequest` and enforces its own HMAC signature. `/voice` uses its own webhook secret.

### Dashboard

- `GET /dashboard` — interactive HTML dashboard
  - `view=daily|weekly` (default `daily`)
  - `range=1w|4w` (default `1w`)
  - `program=home_delivery|in_person_shopping|pre_made_bags` (optional outbound filter)
  - `format=html|csv|raw` (default `html`)
  - `from=YYYY-MM-DD&to=YYYY-MM-DD` (with `format=raw` only)

### Review UI

- `GET /review` — inbound + outbound queues (tabs: `queue`, `history`, `suggestions`)
- `GET /review/slip?slip=<base64-photo_url>` — per-slip detail (photo + editable table)
- `GET /review/outbound/slip?slip=…` — outbound (whiteboard/text/voice) detail
- `GET /review/upload` — bulk web upload page (multi-file, image/PDF)
- `GET /review/photo?slip=…` — server-side proxy for source photos (Slack via bot token, or R2/in-memory for `loadslip.upload/<hash>` URLs)
- `POST /api/review/edit` — apply a single field edit; writes cell, appends Corrections Log, recomputes Inventory Summary, re-opens the slip
- `POST /api/review/approve` — stamp `approved_at` / `approved_by` on every row of a slip; also syncs Inventory Summary
- `POST /api/review/outbound/approve` — same, outbound side
- `POST /api/prompt-suggestions/{approve,reject}` — admin-only

### Ingest

- `POST /api/inbound-email` — HMAC-signed (`X-Loadslip-Signature: sha256=…`) payload of `{messageId, from, subject, attachments[]}`. Handler re-checks sender allowlist, dedupes on `Message-ID` against `Processed Emails`, then processes each attachment through the same pipeline as bulk upload.
- `POST /grocery-rescue/upload` — accepts an XLSX or CSV, parses each month tab into synthetic per-line rows, and writes through the standard append path.
- `POST /voice` — Alexa-style EOD webhook.

### Labels

- `GET /labels` and `/labels/scan` — printable QR-code labels for Crates (see PR #69).

## Google Sheet tabs

Written by `sheets.ts`. Tabs and headers auto-created on first write. `SHEET_HEADERS` order is load-bearing — insert new columns at the end only.

- **Inbound Delivery Log** (`GOOGLE_WORKSHEET_NAME`, default `Inbound Delivery Log`) — one row per line item from inbound. Slip grouping key: `photo_url`.
- **Outbound Delivery Log** (`EOD_WORKSHEET_NAME`, default `Outbound Delivery Log`) — one row per outbound line (whiteboard/text/voice); `source` column disambiguates.
- **Inventory Summary** — one row per inbound shipment; appended live at ingest, recomputed on any review-UI edit or approve.
- **Corrections Log** — append-only audit trail of every review-UI edit. **Source of truth for prompt tuning.**
- **Extraction Traces** — append-only per-invoice log: model, tokens, cost, tool-input JSON, and Claude's thinking chunked across `thinking_1/2/3`. Survives Railway redeploys; go here when logs have flushed.
- **Prompt Suggestions** — reviewer-submitted (and agent-tuner-filed) prompt-improvement ideas. Admin-only approve/reject.
- **Processed Emails** — one row per email attachment. Message-ID dedup + result (`processed`, `dedup_sheet`, `dedup_message_id`, `unsupported_mime`, `extraction_failed`).
- **Crates** — QR-labeled physical crate registry (PR #69).

## Auto-write vs staged write

| Path | Trigger | Confidence gate | Action |
|---|---|---|---|
| Inbound photo/PDF (Slack, email, web) | file arrival | avg conf ≥ 0.7 → auto-write; below → still writes but slip lands in review queue | Auto-writes; review-UI gate at `REVIEW_CONFIDENCE_THRESHOLD` (0.75) |
| Whiteboard photo | classifier returns `whiteboard` | same 0.7 gate | Auto-writes |
| EOD text (`eod: …`) | message starts with `eod:` | none | Stages, waits for 👍 / ❌ |
| EOD voice memo | audio file share | none | Whisper → stage, waits for 👍 / ❌ |
| Assistant correction | @mention proposes one | none | Stages, waits for 👍 / ❌ |
| Grocery Rescue XLSX | web upload | n/a (parsed, no vision) | Auto-writes |

The two confidence thresholds are **separate**: the 0.7 in `index.ts` decides whether to write anything at all; the 0.75 in `config.ts` decides whether the slip lands in the "Needs review" queue. Don't unify them without thinking through both effects.

## Deploy

`main` → Railway auto-deploys (`railway.toml`, Dockerfile build). Branch protection on `main` enforces CODEOWNERS review for the touchy files below. Rollback: Railway → Deployments → "Redeploy" on the last known-good build. See `RUNBOOK.md`.

Auth in prod is Cloudflare Access at `review.loadslip.com`. The `/api/inbound-email` path has a dedicated Access **Bypass** app so the CF Worker can POST directly (see `project_rvfb_email_intake.md`).

## Prompt-change gating

`.github/CODEOWNERS` requires owner review on:

- `prompts/**` — every vendor-specific extraction prompt
- `src/types.ts`, `src/sheets.ts`, `src/extraction.ts` — schema and routing

Corrections Log → agent-tuner runs daily → files Prompt Suggestions and (with `--open-pr`) opens tuner PRs branched `tuner/<supplier>-<field>-<YYYYMMDD>`. CODEOWNERS still gates the merge.

## One-off scripts

Under `src/backfill-*.ts` — all support `--apply` (default dry-run) and most `--limit=N`:

- `backfill-summary-recompute.ts` — rebuild Inventory Summary from Inbound Delivery Log
- `backfill-is-donation.ts` — populate `is_donation` for historical rows
- `backfill-auto-approve.ts` — retroactively approve above-threshold historical slips
- `backfill-charlies-pack-weight.ts` — derive weight from Charlie's pack notation
- `backfill-charlies-reextract-weights.ts` — re-run extraction against the current prompt for Slack-hosted Charlie's slips (fills what pack-fallback can't)
- `backfill-carusos-catalog-weight.ts` — apply scraped Caruso catalog weights
- `backfill-carusos-pack-weight.ts` — Caruso pack-notation fallback
- `backfill-donor-org-canonical.ts` — normalize grocery-rescue donor short codes
- `backfill-grocery-rescue-supplier.ts` — split legacy grocery-rescue rows out of `food_lifeline`
- `backfill-outbound-photo-url.ts` — recover missing photo_urls on historical outbound rows
- `backfill-rescue-invoice-synth.ts` — synthesize `<donor>-<date>` invoice numbers for grocery-rescue dedup
- `backfill-rescue-skeleton-rows.ts` — enforce the rescue-skeleton row invariant

Utilities:

- `audit-inbound-weight-coverage.ts` — per-supplier weight-coverage snapshot
- `audit-inventory-summary.ts` — summary invariants (missing / orphan / duplicate / mismatch / nulls)
- `dump-caruso-skus.ts` — enumerate RVFB-seen Caruso SKUs; feeds the catalog re-scrape
- `reextract-one.ts` — re-run extraction on a single Slack-hosted slip

Caruso catalog scrape (Playwright) in `scripts/caruso-scrape/` — run `scrape-listing.js` → `enrich.js` → `scrape-weights.js` → `merge.js` to refresh `data/caruso-catalog.json`.

## Eval harness

`npm test` runs `tests/extraction.spec.ts` against pinned fixtures in `tests/fixtures/`. Each fixture asserts structural facts stable across model versions (supplier classification, minimum line-item count, fee presence, key item-name substrings, totals presence, `is_donation`, `donor_org`, and — for suppliers with a printed weight column — `minApproxWeightCoverage`).

Hits the live Anthropic API; full suite costs a few dollars. When iterating on one supplier's prompt, run only its fixture:

```bash
FIXTURE_SUPPLIER=charlies npm test
```

Pre-resize new fixtures with `sips -Z 2000 <file>` before committing (10 MB base64 cap).

`npm run test:unit` runs the fast pure-function suite (~1s, no API cost). `npm run typecheck` runs `tsc --noEmit`.

## Next improvements

- **Historical Charlies backfill** — run `backfill-charlies-reextract-weights.ts --apply` against Slack-hosted slips (the `loadslip.upload/*` ones are unrecoverable pre-R2).
- **Body-text extraction path** for vendors that send HTML-body invoices with no PDF attachment.
- **Product normalization dictionary** in a Sheets `Products` tab (today, normalization is hardcoded supplier-by-supplier).
- **Eval-gate on tuner PRs** — extend fixtures per-supplier before auto-merging tuner-generated prompt edits.
