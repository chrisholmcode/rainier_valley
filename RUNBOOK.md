# RUNBOOK

Operational runbook for the RVFB intake bot. Read `README.md` for what the bot does and `CLAUDE.md` for how the code is organized; this file is for **the bot is misbehaving in production, what do I do.**

Owner: Chris Holm (chrischolm@gmail.com).
RVFB primary contact: see the `#general` Slack DM list (kept off this repo on purpose).

## Live URLs

- Slack workspace: Rainier Valley Food Bank
- Production deploy: Railway project `food-bank-inventory` (auto-deploys from `main`)
- Dashboard: `https://<railway-domain>/dashboard?token=<DASHBOARD_TOKEN>`
- Review UI: `https://<railway-domain>/review?token=<DASHBOARD_TOKEN>`
- Google Sheet: pinned in the Slack channel; ID lives in `GOOGLE_SPREADSHEET_ID`

## Environment variables

Authoritative source: `src/config.ts` (zod schema). Everything below comes from there.

### Required

| Var | What it is | Notes |
|---|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` | Bot OAuth token |
| `SLACK_SIGNING_SECRET` | Slack app signing secret | |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Workspace key, not user key |
| `GOOGLE_SPREADSHEET_ID` | Sheet ID (from URL) | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` **or** `GOOGLE_APPLICATION_CREDENTIALS` | Service account creds | On Railway use the JSON env var; file path is local-dev only |

### Recommended

| Var | Default | What it does |
|---|---|---|
| `SLACK_APP_TOKEN` | — | `xapp-…` enables Socket Mode (prod uses it; no public Slack endpoint required) |
| `INVENTORY_CHANNEL_ID` | — | Locks ingestion to one channel; leave unset to accept any channel the bot is in |
| `ASSISTANT_CHANNEL_ID` | — | Locks @mention assistant to one channel |
| `DASHBOARD_TOKEN` | — | Gates `/dashboard` AND `/review`. Without it, both routes return 404 |
| `REVIEW_CONFIDENCE_THRESHOLD` | `0.75` | Slips with any item below this land in "Needs review" |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Override for whiteboard/EOD/assistant. Invoice extraction has its own pinned model in `extraction.ts` |
| `OPENAI_API_KEY` | — | Whisper for voice memos; without it, voice uploads error politely |
| `VOICE_WEBHOOK_SECRET` | — | Bearer token for `POST /voice` (Alexa) |

### Sheet tab names (rarely changed)

`GOOGLE_WORKSHEET_NAME` (`Inbound Delivery Log`), `EOD_WORKSHEET_NAME` (`Outbound Delivery Log`), `SUMMARY_WORKSHEET_NAME` (`Inventory Summary`), `CORRECTIONS_LOG_WORKSHEET_NAME` (`Corrections Log`).

## Common failure modes

### "The bot isn't responding in Slack"

1. **Check Railway deploy status.** Railway dashboard → project → most recent deploy should be green. If it's crash-looping, jump to "Container won't start" below.
2. **Check Socket Mode.** Without `SLACK_APP_TOKEN`, the bot falls back to HTTP mode and Slack can't reach it. Verify the env var is set.
3. **Check channel scoping.** If `INVENTORY_CHANNEL_ID` is set, only that channel is ingested. If someone moved the bot to a different channel, it'll look dead.
4. **Tail logs** — Railway → project → "View logs" or via CLI:
   ```sh
   railway logs --service food-bank-inventory
   ```
   Look for "Slack app started in Socket Mode" on boot. If you see it but no event logs when you upload, Slack isn't routing — re-check the App-Level Token scope (`connections:write`).

### "A photo was uploaded but nothing happened"

The bot logs every received event. From the project root:

```sh
railway logs --service food-bank-inventory | grep -A 4 'Received message event'
```

Things to check in order:

1. **Mimetype filter** — only `image/*` and `application/pdf` are accepted (`index.ts`). HEIC from iOS Mail is `image/heic` → fine. PDFs are fine.
2. **Confidence gate** — if avg extraction confidence is `< 0.7`, the bot posts a "confidence too low" message and does **not** write to sheets. Re-upload with better lighting.
3. **Dedupe** — if the user re-uploads after a deploy, the in-memory dedupe set is fresh and won't block. But if they re-upload the **same** file in the same process lifetime, you'll see "appears to be a duplicate".
4. **Anthropic credit exhaustion** → the bot posts an explicit `⚠️ Bot is offline — Anthropic API credit ran out` message. Top up at console.anthropic.com → Plans & Billing.

### "Extraction is wrong / supplier is wrong"

1. **Check the Corrections Log tab** — that's the source of truth for which fields and suppliers are drifting.
2. **Reproduce locally** with the saved fixture: drop the photo in `tests/fixtures/`, add a `FixtureCase` to `tests/extraction.spec.ts`, `npm test` that one fixture.
3. **Tune the supplier prompt** in `prompts/invoice/suppliers/<slug>.md`. Re-run the fixture. When it passes, open a PR (CODEOWNERS requires review).
4. To re-extract one slip without re-uploading in Slack:
   ```sh
   npx tsx src/reextract-one.ts <photo_url>
   ```

### "Sheet writes are failing"

Two common Sheets errors and what they mean:

- **`exceeds grid limits` / `Unable to parse range`** → `SHEET_HEADERS` has more columns than the sheet grid. `ensureSheetHeader` should fix this automatically on the next write. If it's stuck, manually add columns to the sheet in the Google UI, or delete the tab and let `ensureTabExists` recreate it (loses no data; new tab is created and existing tab is untouched — actually verify before deleting).
- **`The caller does not have permission`** → the spreadsheet was re-shared or the service account email was removed. Re-share the sheet as Editor with the service account email (it's in the JSON cred).

The user-facing friendly error mapping is in `friendlyErrorMessage` in `src/index.ts:609`. Add new patterns there when you find a recurring confusing error.

### "Review UI is empty / 404"

- `/review` returns 404 if `DASHBOARD_TOKEN` is unset.
- 401 means token mismatch — check the env var matches the URL query param.
- Empty queue is normal if no slips are below threshold. Switch to `?tab=history` to confirm slips exist.

### "Voice memo did nothing"

- `OPENAI_API_KEY` must be set; the bot posts a polite error if not.
- Whisper API failures surface in logs as a generic EOD-processing error.

## Container won't start

Railway shows the crash log. Most common causes:

1. **Missing required env var** — `config.ts` throws with `Invalid environment configuration: …` listing each missing/invalid var. Fix the env var and Railway will redeploy automatically.
2. **Bad `GOOGLE_SERVICE_ACCOUNT_JSON`** — if the JSON has unescaped newlines (from a paste), parsing fails. The JSON must be single-line with `\n` literals inside the private key.
3. **Slack token revoked** — Slack will return 401 on `app.start()`. Re-issue from api.slack.com/apps.

## Rollback

Last-known-good deploy:

1. Railway dashboard → project → Deployments
2. Find the previous green deploy
3. Click the three-dot menu → **Redeploy**

Or via CLI:

```sh
railway redeploy --deployment <deployment-id>
```

If the bad change is in `main`, also revert the commit so the next push doesn't re-introduce it:

```sh
git revert <sha>
git push origin main
```

## Data recovery / backfills

- **Backfill `is_donation` on historical rows:** `npm run backfill:is-donation`. Reads `Inbound Delivery Log`, uses the supplier mapping (`DONATION_SUPPLIERS` in `sheets.ts`) plus Grand Central's `- Donation` / `- Purchased` customer-field convention to set the flag. Idempotent; safe to re-run.
- **Rebuild `Inventory Summary`:** `npm run build && node dist/backfill-summary.js`. Drops and rebuilds the Inventory Summary tab from the Inbound Delivery Log. Use after a schema migration that changes how summary rows are computed.
- **Re-extract a single slip:** `npx tsx src/reextract-one.ts <photo_url>`. Hits the live API. Useful when a prompt fix should be applied retroactively to one specific slip.

## Smoke test after a deploy

1. Upload a known-good test invoice in Slack (Caruso's IMG_2718 from `tests/fixtures/` works).
2. Expect within ~30s: a thread reply with the extraction table, "Avg confidence", and "Logged N row(s) to Google Sheets."
3. Open `/review` — slip should appear in the queue if any item is below threshold, otherwise in Completed.
4. Open the dashboard `/dashboard` — today's row should reflect the new shipment.

## Escalation

- **Slack issues:** Chris Holm (Slack workspace owner).
- **Google Sheet issues:** Chris Holm (service-account creds).
- **Railway/billing:** Chris Holm.
- **Anthropic billing:** Chris Holm (workspace owner on console.anthropic.com).
- **RVFB-side data questions:** RVFB ops lead — kept off this repo; ask Chris.
