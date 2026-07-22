# CLAUDE.md

Orientation for AI coding agents working in this repo. The README is the human-facing description of what the bot does; this file tells you **where things live, what the contracts are, and what is easy to break**. Read both before editing.

## What this is

Slack-first intake bot for Rainier Valley Food Bank. Three live ingest paths feed two Google Sheets, plus a browser Review UI for human signoff on low-confidence slips. Deployed to Railway from `main`. Production system for a real food bank — broken extractions cost RVFB time, not just embarrassment.

## Stack at a glance

- **Runtime:** Node 22, TypeScript (ESM, `type: module`), `tsx` for dev.
- **Slack:** `@slack/bolt` v4 in **Socket Mode** (`SLACK_APP_TOKEN` present) — no public HTTP endpoint required for Slack.
- **Vision/LLM:** `@anthropic-ai/sdk`. Invoice extraction uses `claude-opus-4-8` with adaptive summarized thinking; whiteboard, EOD text, and assistant use `claude-sonnet-4-6` (`ANTHROPIC_MODEL` override).
- **Audio:** OpenAI Whisper for voice memo transcription.
- **Sheets:** `googleapis` Sheets API v4 via a service account.
- **HTTP:** Node `node:http` server (no Express) on `PORT` (Railway) or `VOICE_PORT` (default 3001). Serves `/dashboard`, `/review*`, `/voice`.
- **Schema validation:** `zod` everywhere extraction crosses a process boundary.

## Source map

```
src/
  index.ts              Slack event wiring + HTTP routes (do not split until it actually hurts)
  config.ts             Env schema (zod). New env vars MUST be declared here or they're invisible.
  extraction.ts         Anthropic tool-use extraction for invoices, whiteboard, EOD text, voice
  prompts.ts            Loader for prompts/** markdown files
  sheets.ts             All Google Sheets reads/writes; header reconciliation; slip grouping
  dashboard.ts          HTML + CSV rendering for /dashboard
  review.ts             HTML rendering for /review and /review/slip
  ui-styles.ts          Shared inline CSS for dashboard + review (Stripe/Ramp-ish)
  assistant.ts          @mention loop: tool-use over readDeliveryRows / readEodRows / proposeCorrection
  types.ts              Shared types — ExtractionResult, DeliverySheetRow, ProgramType, etc.
  backfill-*.ts         One-off scripts; ok to delete after they've run if not reusable
  reextract-one.ts      Re-run extraction on one slip (debugging)
  test-extraction.ts    Ad-hoc extraction harness (not the test suite)

prompts/
  classify/             Whiteboard-vs-invoice classifier prompt
  invoice/system.md     Shared invoice extraction prompt
  invoice/suppliers/*.md  Per-supplier extraction rules (carusos, charlies, costco, food_lifeline, grand_central, grocery_rescue, nw_harvest, pacific, terrebonne, weigelt, unknown)
  whiteboard/           Whiteboard extraction prompt
  eod/                  EOD text/voice extraction prompt

tests/
  extraction.spec.ts    Eval harness — runs real extractFromImage against tests/fixtures/
  fixtures/             Pinned slips. Hits the live API. Pre-resize big images (`sips -Z 2000`)
```

## The two-sheet write contract

Two sheets, two write paths. Don't confuse them.

- **Inbound Delivery Log** (`GOOGLE_WORKSHEET_NAME`) — one row per line item from purchased/donated inbound. Written by `appendExtractionRows`. Slip-grouping key is `photo_url`.
- **Outbound Delivery Log** (`EOD_WORKSHEET_NAME`) — one row per line item for **whiteboard outbound**, **EOD text**, and **EOD voice**. Written by `appendEodRows`. The `source` column (`whiteboard`/`text`/`voice`) is what tells the dashboard whether it's outbound-delivery or end-of-day inventory.
- **Inventory Summary** — one row per inbound shipment, appended live (`appendSummaryRow`) and recomputed from scratch (`recomputeSummaryForSlip`) any time a review-UI edit lands on that slip's rows.
- **Corrections Log** — append-only audit trail of every Review-UI edit. **Source of truth for which supplier prompts need tuning.**
- **Extraction Traces** — append-only per-invoice log written by `appendExtractionTrace` right after `extractFromImage`. Captures Claude's thinking (chunked across `thinking_1`/`thinking_2`/`thinking_3` at 45k chars each), the raw tool-input JSON, model, token usage, and Caruso reconcile stats. Survives Railway redeploys — go here when Railway logs have flushed.
- **Prompt Suggestions** — reviewer-submitted free-form suggestions for prompt improvements. Submitted from the slip-detail page (`/review/slip`), listed at `/review?tab=suggestions`. Only `ADMIN_EMAIL` (default `chrischolm@gmail.com`) can approve/reject. On submission the bot DMs `ADMIN_SLACK_USER_ID` if set. Nothing writes to `prompts/**` at runtime — approvals just mark the suggestion resolved; Chris still lands the code change manually.

`sheets.ts` auto-creates missing tabs (`ensureTabExists`) and grows `columnCount` when `SHEET_HEADERS` adds new columns. Adding a column is just a `SHEET_HEADERS` push; do **not** also manually widen the sheet.

## Auto-write vs staged write

| Path | Trigger | Confidence gate | Action |
|---|---|---|---|
| Inbound photo (image/PDF) | `message.subtype = file_share` | avg conf ≥ `CONFIDENCE_THRESHOLD` (0.7, in `index.ts`) | **Auto-writes** immediately |
| Whiteboard photo | classifier returns `whiteboard` | same 0.7 gate | **Auto-writes** immediately |
| EOD text (`eod: …`) | message starts with `eod:` | none | **Stages**, waits for 👍 / ❌ reaction |
| EOD voice memo | message has audio file | none | Whisper → stage, wait for 👍 / ❌ |
| Assistant correction | @mention proposes one | none | Stages, waits for 👍 / ❌ |

The 0.7 photo-intake gate (in `index.ts`) is **separate** from `REVIEW_CONFIDENCE_THRESHOLD` (0.75, in `config.ts`) — the first decides whether to write anything at all; the second decides whether the slip lands in the Review-UI "Needs review" queue. Don't unify them without thinking through both effects.

## Slack event flow

One `app.event("message", …)` handles file uploads (photos/PDFs → invoice or whiteboard). A separate `app.message(…)` handler routes the EOD text and voice-memo paths. The order matters: the file-share handler skips audio files, and the text handler skips `<@…>` (handled by `app_mention`).

Duplicate suppression in `index.ts` is three layers, all in-memory (lost on restart):

1. `processedMessageKeys` — channel:ts dedupe.
2. `processedFileIds` — Slack file ID dedupe.
3. `processedContentHashes` — sha256 of file bytes (catches re-uploads).
4. `processedInvoiceKeys` — `supplier:invoice_or_order_number` dedupe (catches re-photographed slips).

A redeploy clears all four sets. That's fine in practice because the sheet-level `is_donation` / `photo_url` dedupes are downstream.

## Prompts are code

Every prompt is a markdown file in `prompts/`. Vendor-specific extraction rules live in `prompts/invoice/suppliers/<slug>.md`. The `system.md` sibling is the shared base.

`prompts.ts` loads them at runtime, so you can edit a prompt and `npm run dev` without rebuilding. Keep the YAML-ish shape — `loadPrompt` strips frontmatter if present.

`.github/CODEOWNERS` requires owner review on `prompts/**`, `src/types.ts`, `src/sheets.ts`, `src/extraction.ts`. Treat changes to those as schema changes.

## Adding a new supplier

1. Add slug to the `Supplier` enum in `src/types.ts`.
2. Add slug to the `supplier` zod enum in `extractionSchema` (`src/extraction.ts`).
3. Write `prompts/invoice/suppliers/<slug>.md` (mirror the structure of an existing one — document layout, date format, fee handling, `approx_weight` derivation).
4. Add a filename heuristic to `guessSupplierFromFilename` and/or `guessSupplierFromText` (`src/extraction.ts` and `src/index.ts`).
5. If the supplier is donation-only, add to `DONATION_SUPPLIERS` (search `sheets.ts`) so `is_donation` falls back correctly.
6. Add a fixture + `FixtureCase` entry in `tests/extraction.spec.ts`.
7. Update the supplier table in `README.md`.

## Verification

`npm test` runs the eval harness against pinned fixtures. **It hits the live Anthropic API** — a full run costs a few dollars. When iterating on one supplier's prompt, run only that fixture (comment out the rest of `FIXTURES`). Pre-resize new fixtures with `sips -Z 2000 <file>` before committing (the SDK enforces a 10 MB base64 cap).

`npm run typecheck` is the fast sanity check before any commit.

## Deploy

- `main` → Railway auto-deploys (`railway.toml`, Dockerfile build).
- Branch protection on `main` enforces CODEOWNERS review for the touchy files above.
- Rollback: Railway → Deployments → "Redeploy" on the last known-good build. See `RUNBOOK.md`.

## Things that will bite you

- **`SHEET_HEADERS` order is load-bearing.** `readDeliveryRows` parses by column position. Inserting in the middle, not at the end, will silently misread historical rows.
- **Adding a column ≠ populating it.** New columns appear as empty cells on every existing row until you backfill. The Review UI treats "empty" as "missing," which is often invisible until a reviewer opens an old slip and asks *"why is this blank?"* (See PR #19 → #32 for the four-day gap on `photo_url`.) When you add to `SHEET_HEADERS` / `EOD_SHEET_HEADERS`, either ship a `src/backfill-*.ts` in the same PR **or** leave a `// TODO backfill(column_name): reason` comment on the line you added — one grep-able marker is enough to keep the followup honest.
- **Sheets `USER_ENTERED` will coerce numeric-looking strings.** Any column that holds a numeric-looking identifier (Slack ts, item codes, invoice numbers with all-digit values) must be written through `asSheetText()` — otherwise Sheets stores it as a float, display-truncates, and breaks round-trip. See PR #33 for the `slack_message_ts` fix; extend the same treatment to any new identifier column.
- **Slack `url_private_download`** requires `Authorization: Bearer SLACK_BOT_TOKEN`. The Review UI's `/review/photo` proxy is the only sanctioned way to render slip photos in a browser.
- **In-memory dedupe** does not survive a Railway restart. If you're debugging a "why did it ingest twice" bug after a deploy, that's why.
- **Anthropic credit exhaustion** surfaces as a Slack error via `friendlyErrorMessage`. The bot does not auto-retry. Slips dropped during an outage have to be re-uploaded.
- **Inventory Summary is recomputed** on Review-UI edits — never read it as authoritative for a slip whose rows you just edited until `recomputeSummaryForSlip` has run.
- **Confidence thresholds are split** between `index.ts` (0.7 photo-intake gate) and `config.ts` (0.75 review-queue threshold). Both are env-tunable in practice (`CONFIDENCE_THRESHOLD` is currently hardcoded; `REVIEW_CONFIDENCE_THRESHOLD` is env-driven).

## When in doubt

- **Sheet column changed?** → also edit `DeliverySheetRow` / `EodSheetRow` in `types.ts` and the row-parsing logic in `sheets.ts`.
- **New extraction field?** → update the zod schema in `extraction.ts`, the prompt(s), `types.ts`, `SHEET_HEADERS`, and the row-write functions in `sheets.ts`. If reviewers should be able to edit it, add to `SLIP_LEVEL_FIELDS` or `ROW_LEVEL_FIELDS` in `index.ts`.
- **Reviewer can't edit a field?** → check `SLIP_LEVEL_FIELDS` / `ROW_LEVEL_FIELDS` in `index.ts`.
- **Slip won't show in /review?** → it's either above `REVIEW_CONFIDENCE_THRESHOLD` or already approved. Approval is cleared on any edit.
