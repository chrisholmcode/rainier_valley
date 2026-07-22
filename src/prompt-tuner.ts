// prompt-tuner.ts — Tier 1 self-improvement loop (read-only, no writes, no Slack).
//
// Reads the Corrections Log (every human Review-UI edit) and joins each correction
// back to its Extraction Trace (via slip_key === trace.photo_url) to recover the
// supplier and the model's own thinking on that slip. Clusters the corrections by
// supplier × field, and for each hot cluster asks Claude to (a) diagnose the root
// cause and (b) propose a MINIMAL, LOCALIZED edit to that one supplier prompt file.
//
// This is the pragmatic, weight-free analog of "little AIs editing the big AI's
// brain": the per-supplier prompt files are the localized update surface, and the
// Corrections Log is the per-datapoint learning signal. Nothing is written anywhere
// — the tool prints proposals to stdout so a human can eyeball the diagnoses before
// any of it is wired into the Prompt Suggestions flow.
//
// Usage:
//   npm run tune:prompts                          # dry-run: print proposals to stdout
//   npm run tune:prompts -- --supplier carusos
//   npm run tune:prompts -- --min-cluster 3 --limit 1000
//   npm run tune:prompts -- --no-llm              # clustering only, zero API cost
//   npm run tune:prompts -- --json                # machine-readable output
//   npm run tune:prompts -- --write-suggestions   # file each proposal as a Prompt
//                                                 # Suggestion (agent-tuner) and DM
//                                                 # ADMIN_SLACK_USER_ID. Deduped by
//                                                 # (supplier,field) signature.
//   npm run tune:prompts -- --open-pr             # for each cluster with an
//                                                 # automatable search→replace edit,
//                                                 # apply it, push a branch
//                                                 # (tuner/<supplier>-<field>-<date>),
//                                                 # and open a PR against main. Skips
//                                                 # if search_text is missing/ambiguous
//                                                 # or the branch already exists on
//                                                 # origin. Caps at --max-prs (default 3)
//                                                 # opens per run. Requires `gh` on PATH
//                                                 # and a working tree that starts
//                                                 # clean on main.
//   npm run tune:prompts -- --open-pr --pr-dry-run  # do everything except push + gh
//                                                   # pr create; logs what would happen.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleAuth } from "google-auth-library";
import { google } from "googleapis";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./config.js";

// Supplier slugs that have a dedicated invoice prompt file. Kept in sync by hand
// with the `supplier` zod enum in extraction.ts — this script is read-only and
// deliberately does not import from the CODEOWNERS-gated modules.
const INVOICE_SUPPLIERS = [
  "carusos", "charlies", "costco", "food_lifeline", "grand_central",
  "grocery_rescue", "nw_harvest", "pacific", "terrebonne", "weigelt", "unknown"
] as const;

const PROMPTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "prompts");
const SUPPLIER_PROMPT = (slug: string) => join(PROMPTS_ROOT, "invoice", "suppliers", `${slug}.md`);

// ── Sheets client (mirrors sheets.ts auth, but never imports it) ────────
// Full spreadsheets scope: we read Corrections Log + Extraction Traces + Prompt
// Suggestions, and in --write-suggestions mode append rows to Prompt Suggestions.
const SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = env.GOOGLE_SERVICE_ACCOUNT_JSON
  ? new GoogleAuth({ credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: SHEETS_SCOPES })
  : new GoogleAuth({ scopes: SHEETS_SCOPES });
const sheetsApi = google.sheets({ version: "v4", auth });

// Column order is load-bearing and mirrors CORRECTIONS_LOG_HEADERS / TRACE_SHEET_HEADERS
// in sheets.ts. If those headers change, update these indices.
const C = { timestamp: 0, user: 1, slip_key: 2, sheet: 3, row_index: 4, field: 5, old_value: 6, new_value: 7, reason: 8 };
const T = { supplier: 2, photo_url: 7, extracted_json: 18, thinking_1: 19 };

type Correction = {
  timestamp: string; user: string; slipKey: string; sheet: string;
  field: string; oldValue: string; newValue: string; reason: string;
  supplier: string; // resolved via trace join, or "(no trace)"
};

type TraceInfo = { supplier: string; thinking: string };

type Args = {
  limit: number; minCluster: number; supplier: string | null;
  noLlm: boolean; json: boolean; maxExamples: number;
  writeSuggestions: boolean;
  openPr: boolean; maxPrs: number; prDryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const envWrite = process.env.TUNER_WRITE_SUGGESTIONS === "1" || process.env.TUNER_WRITE_SUGGESTIONS === "true";
  const envOpenPr = process.env.TUNER_OPEN_PR === "1" || process.env.TUNER_OPEN_PR === "true";
  const a: Args = {
    limit: 500, minCluster: 2, supplier: null, noLlm: false, json: false, maxExamples: 5,
    writeSuggestions: envWrite,
    openPr: envOpenPr, maxPrs: 3, prDryRun: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--limit") a.limit = parseInt(argv[++i], 10);
    else if (arg === "--min-cluster") a.minCluster = parseInt(argv[++i], 10);
    else if (arg === "--supplier") a.supplier = argv[++i];
    else if (arg === "--max-examples") a.maxExamples = parseInt(argv[++i], 10);
    else if (arg === "--no-llm") a.noLlm = true;
    else if (arg === "--json") a.json = true;
    else if (arg === "--write-suggestions") a.writeSuggestions = true;
    else if (arg === "--open-pr") a.openPr = true;
    else if (arg === "--max-prs") a.maxPrs = parseInt(argv[++i], 10);
    else if (arg === "--pr-dry-run") a.prDryRun = true;
  }
  return a;
}

async function readTab(tab: string, range: string): Promise<string[][]> {
  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${tab}!${range}`
  });
  return (res.data.values ?? []) as string[][];
}

async function loadCorrections(limit: number): Promise<Correction[]> {
  const [rawCorrections, rawTraces] = await Promise.all([
    readTab(env.CORRECTIONS_LOG_WORKSHEET_NAME, "A2:I"),
    readTab(env.EXTRACTION_TRACES_WORKSHEET_NAME, "A2:W")
  ]);

  // Build photo_url -> trace. Traces are append-only and a slip can be re-extracted,
  // so the LAST row for a photo_url wins (most recent extraction).
  const traceBySlip = new Map<string, TraceInfo>();
  for (const r of rawTraces) {
    const url = r[T.photo_url];
    if (!url) continue;
    traceBySlip.set(url, { supplier: r[T.supplier] ?? "unknown", thinking: r[T.thinking_1] ?? "" });
  }

  const corrections: Correction[] = rawCorrections.map((r) => {
    const slipKey = r[C.slip_key] ?? "";
    const trace = traceBySlip.get(slipKey);
    // If the reviewer corrected the `supplier` field itself, the true supplier is
    // the new value — prefer it over the trace's (wrong) guess for clustering.
    let supplier = trace?.supplier ?? "(no trace)";
    if (r[C.field] === "supplier" && r[C.new_value]) supplier = r[C.new_value];
    return {
      timestamp: r[C.timestamp] ?? "", user: r[C.user] ?? "", slipKey,
      sheet: r[C.sheet] ?? "", field: r[C.field] ?? "",
      oldValue: r[C.old_value] ?? "", newValue: r[C.new_value] ?? "",
      reason: r[C.reason] ?? "", supplier
    };
  });

  return corrections.slice(-limit);
}

type Cluster = { supplier: string; field: string; corrections: Correction[] };

function clusterBySupplierField(corrections: Correction[], minCluster: number, supplierFilter: string | null): Cluster[] {
  const groups = new Map<string, Correction[]>();
  for (const c of corrections) {
    if (supplierFilter && c.supplier !== supplierFilter) continue;
    const key = `${c.supplier}::${c.field}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  const clusters: Cluster[] = [];
  for (const [key, cs] of groups) {
    if (cs.length < minCluster) continue;
    const [supplier, field] = key.split("::");
    clusters.push({ supplier, field, corrections: cs });
  }
  // Hottest clusters first — most corrections = highest tuning leverage.
  return clusters.sort((a, b) => b.corrections.length - a.corrections.length);
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const DIAGNOSE_TOOL = "submit_prompt_diagnosis";
const DIAGNOSE_SCHEMA = {
  type: "object",
  properties: {
    root_cause: { type: "string", description: "Why the model made this class of error, grounded in the corrections and the model's own thinking." },
    target_section: { type: "string", description: "Which part of the supplier prompt to edit (quote a heading or the sentence to change)." },
    proposed_edit: { type: "string", description: "A concrete, minimal snippet of prompt text to add or replace. Keep it localized to this supplier and this failure mode — do not rewrite the whole file." },
    regression_risk: { type: "string", description: "What other slips this change could regress, and how to check." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    search_text: { type: "string", description: "Exact substring from the current supplier prompt file that will be replaced. MUST match the file byte-for-byte including whitespace/indentation. MUST appear EXACTLY ONCE in the file — if the natural target text appears multiple times, include enough surrounding context to make it unique. Leave blank if no automatable string replacement is possible (e.g., you're recommending a broader restructure)." },
    replace_text: { type: "string", description: "Exact replacement text. Preserves file style. May span multiple lines. Leave blank whenever search_text is blank." }
  },
  required: ["root_cause", "target_section", "proposed_edit", "regression_risk", "confidence"]
} as const;

type Diagnosis = {
  root_cause: string; target_section: string; proposed_edit: string;
  regression_risk: string; confidence: string;
  search_text?: string; replace_text?: string;
};

async function diagnose(cluster: Cluster, maxExamples: number): Promise<Diagnosis | null> {
  const promptPath = INVOICE_SUPPLIERS.includes(cluster.supplier as never) ? SUPPLIER_PROMPT(cluster.supplier) : null;
  const currentPrompt = promptPath && existsSync(promptPath) ? readFileSync(promptPath, "utf8") : null;
  if (!currentPrompt) return null; // outbound / unknown-supplier clusters have no supplier prompt to tune

  const examples = cluster.corrections.slice(0, maxExamples).map((c, i) => {
    const trace = c.slipKey; // slip identity for the reader
    return [
      `Example ${i + 1}:`,
      `  field:      ${c.field}`,
      `  model wrote: ${c.oldValue || "(blank)"}`,
      `  human fixed: ${c.newValue || "(blank)"}`,
      c.reason ? `  reviewer note: ${c.reason}` : null,
      `  slip: ${trace}`
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const userPrompt = `You are tuning the extraction prompt for supplier "${cluster.supplier}".

Reviewers repeatedly corrected the "${cluster.field}" field on this supplier's slips (${cluster.corrections.length} corrections). Each correction is the model's output followed by the human's fix.

${examples}

Here is the CURRENT supplier prompt file (prompts/invoice/suppliers/${cluster.supplier}.md):
--- BEGIN PROMPT ---
${currentPrompt}
--- END PROMPT ---

Diagnose the root cause of this recurring error and propose a MINIMAL, LOCALIZED edit to THIS prompt file that would prevent it. Do not propose changes to the shared system prompt or to other suppliers. Prefer adding a single targeted rule or example over rewriting sections. Then call ${DIAGNOSE_TOOL}.`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 1500,
    tools: [{ name: DIAGNOSE_TOOL, description: "Submit the prompt-tuning diagnosis and proposed edit.", input_schema: DIAGNOSE_SCHEMA as never }],
    tool_choice: { type: "tool", name: DIAGNOSE_TOOL },
    messages: [{ role: "user", content: userPrompt }]
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  return toolUse.input as Diagnosis;
}

// ── Prompt Suggestions write path (opt-in, --write-suggestions) ─────────────
//
// Mirrors sheets.ts::appendPromptSuggestion column layout deliberately — this
// script never imports from the CODEOWNERS-gated sheets.ts to keep the tuning
// loop's blast radius bounded.
const SUGGESTED_BY = "agent-tuner";
const P = { created_at: 0, submitted_by: 1, supplier: 2, slip_photo_url: 3, suggestion_text: 4, status: 5 };

function suggestionSignature(supplier: string, field: string): string {
  return `agent-tuner:${supplier}:${field}`;
}

function formatSuggestionText(cluster: Cluster, d: Diagnosis): string {
  // The signature comment lets us dedupe: on subsequent runs we skip any
  // (supplier,field) that already has a pending agent-tuner suggestion.
  const sig = suggestionSignature(cluster.supplier, cluster.field);
  return [
    `<!-- signature: ${sig} -->`,
    `**Field:** \`${cluster.field}\` · **Corrections in cluster:** ${cluster.corrections.length} · **Confidence:** ${d.confidence}`,
    ``,
    `**Root cause**`,
    d.root_cause,
    ``,
    `**Target section**`,
    d.target_section,
    ``,
    `**Proposed edit**`,
    d.proposed_edit,
    ``,
    `**Regression risk**`,
    d.regression_risk
  ].join("\n");
}

async function loadPendingAgentSignatures(): Promise<Set<string>> {
  const rows = await readTab(env.PROMPT_SUGGESTIONS_WORKSHEET_NAME, "A2:I").catch(() => [] as string[][]);
  const sigs = new Set<string>();
  for (const r of rows) {
    if ((r[P.submitted_by] ?? "") !== SUGGESTED_BY) continue;
    if ((r[P.status] ?? "") !== "pending") continue;
    const text = r[P.suggestion_text] ?? "";
    const m = text.match(/<!-- signature:\s*(\S+?)\s*-->/);
    if (m) sigs.add(m[1]);
  }
  return sigs;
}

async function appendSuggestion(params: { supplier: string; slipPhotoUrl: string | null; text: string }): Promise<void> {
  const createdAt = new Date().toISOString();
  const row = [createdAt, SUGGESTED_BY, params.supplier, params.slipPhotoUrl ?? "", params.text, "pending", "", "", ""];
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.PROMPT_SUGGESTIONS_WORKSHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function notifyAdmin(params: { supplier: string; field: string; count: number; text: string; slipPhotoUrl: string | null }): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !env.ADMIN_SLACK_USER_ID) return;
  const base = env.CF_ACCESS_TEAM_DOMAIN ? "https://review.loadslip.com" : "";
  const suggestionsLink = base ? `${base}/review?tab=suggestions` : "/review?tab=suggestions";
  const slipLink = params.slipPhotoUrl && base ? `${base}/review/slip?slip=${Buffer.from(params.slipPhotoUrl, "utf-8").toString("base64url")}` : null;
  const msg = [
    `*New prompt suggestion* — ${params.supplier} · \`${params.field}\` (${params.count} corrections)`,
    `From: ${SUGGESTED_BY}`,
    ``,
    `> ${params.text.split("\n").slice(0, 8).join("\n> ")}`,
    `…`,
    ``,
    `<${suggestionsLink}|Review in the UI>${slipLink ? ` · <${slipLink}|source slip>` : ""}`
  ].join("\n");
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
      body: JSON.stringify({ channel: env.ADMIN_SLACK_USER_ID, text: msg })
    });
    const data = await res.json() as { ok?: boolean; error?: string };
    if (!data.ok) console.warn(`admin DM failed: ${data.error}`);
  } catch (err) {
    console.warn(`admin DM error: ${(err as Error).message}`);
  }
}

// ── Auto-open PR path (--open-pr) ──────────────────────────────────────────
//
// Applies the diagnosis's search_text→replace_text pair to the supplier prompt
// file, commits on a per-cluster branch, pushes, and opens a PR against main.
// Uses `gh` (pre-installed on GitHub Actions runners) so no octokit dep is
// pulled into the runtime bundle. Non-destructive: if search_text is missing,
// blank, or matches ≠ 1 times, we skip that cluster and leave the file
// untouched.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

type PrResult =
  | { status: "opened"; branch: string; url: string }
  | { status: "skipped"; reason: string };

function shortDate(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function sanitizeFieldForBranch(field: string): string {
  return field.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function branchExistsOnRemote(branch: string): boolean {
  const r = spawnSync("git", ["ls-remote", "--heads", "origin", branch], { encoding: "utf8" });
  return (r.stdout ?? "").trim().length > 0;
}

function runOrThrow(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) {
    throw new Error(`\`${cmd} ${args.join(" ")}\` failed (exit ${r.status}): ${(r.stderr ?? r.stdout ?? "").trim()}`);
  }
}

function runCapture(cmd: string, args: string[], cwd?: string): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function openTunerPr(params: {
  cluster: Cluster;
  diagnosis: Diagnosis;
  dryRun: boolean;
}): Promise<PrResult> {
  const { cluster, diagnosis, dryRun } = params;
  const search = diagnosis.search_text?.trim() ?? "";
  const replace = diagnosis.replace_text ?? "";
  if (!search) return { status: "skipped", reason: "no search_text — Claude declined an automatable edit" };

  const promptPath = SUPPLIER_PROMPT(cluster.supplier);
  if (!existsSync(promptPath)) return { status: "skipped", reason: `prompt file missing: ${promptPath}` };
  const current = readFileSync(promptPath, "utf8");

  // Strict: require exactly one match so we don't accidentally rewrite the wrong
  // occurrence when a phrase appears in multiple sections.
  const parts = current.split(diagnosis.search_text ?? "");
  if (parts.length - 1 === 0) return { status: "skipped", reason: "search_text not found in current file (drifted?)" };
  if (parts.length - 1 > 1)  return { status: "skipped", reason: `search_text matches ${parts.length - 1} places — needs more context to be unique` };

  const patched = parts.join(replace);
  if (patched === current) return { status: "skipped", reason: "search_text and replace_text are identical" };

  const branch = `tuner/${cluster.supplier}-${sanitizeFieldForBranch(cluster.field)}-${shortDate()}`;
  if (branchExistsOnRemote(branch)) return { status: "skipped", reason: `branch ${branch} already exists on origin — dedup` };

  if (dryRun) {
    return { status: "opened", branch, url: `(dry-run — would have opened PR from ${branch})` };
  }

  // Ensure we're on main. GitHub Actions checks out main by default; local
  // callers should too. Fail loud if the tree is dirty so we don't clobber
  // work-in-progress.
  const status = runCapture("git", ["status", "--porcelain"]);
  if (status.out.length > 0) return { status: "skipped", reason: `working tree not clean — refusing to auto-commit (${status.out.split("\n")[0]})` };

  runOrThrow("git", ["checkout", "-B", branch]);
  writeFileSync(promptPath, patched);
  runOrThrow("git", ["add", promptPath]);

  const commitMsg = `tuner: ${cluster.supplier} — tighten \`${cluster.field}\` extraction (${cluster.corrections.length} corrections)\n\n${diagnosis.root_cause.slice(0, 500)}\n\nSignal: prompt-tuner ${SUGGESTED_BY} run, cluster of ${cluster.corrections.length} corrections filed as agent-tuner suggestion.\n\nCo-Authored-By: agent-tuner <noreply@anthropic.com>`;
  runOrThrow("git", ["commit", "-m", commitMsg]);
  runOrThrow("git", ["push", "-u", "origin", branch]);

  const title = `tuner: ${cluster.supplier} — tighten ${cluster.field} extraction (${cluster.corrections.length} corrections)`;
  const body = [
    `> Auto-opened by \`prompt-tuner\` (${SUGGESTED_BY}). Signal cluster: ${cluster.corrections.length} corrections on \`${cluster.supplier}\` × \`${cluster.field}\`. Confidence: **${diagnosis.confidence}**.`,
    ``,
    `## Root cause`,
    diagnosis.root_cause,
    ``,
    `## Target section`,
    "```",
    diagnosis.target_section,
    "```",
    ``,
    `## Proposed edit`,
    diagnosis.proposed_edit,
    ``,
    `## Regression risk`,
    diagnosis.regression_risk,
    ``,
    `## Reviewer checklist`,
    `- [ ] The applied search→replace matches the intent described above.`,
    `- [ ] No other supplier prompt or shared system prompt was touched.`,
    `- [ ] Regression risks called out have been thought through.`,
    `- [ ] (Optional) Re-run \`npm test\` on the two relevant fixtures.`
  ].join("\n");

  const pr = runCapture("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", title, "--body", body]);
  if (pr.code !== 0) {
    // Best-effort cleanup: get back to main; leave the branch on remote for
    // manual triage.
    runCapture("git", ["checkout", "main"]);
    throw new Error(`gh pr create failed: ${pr.err || pr.out}`);
  }
  const url = pr.out.split("\n").find((l) => l.startsWith("https://")) ?? pr.out;

  runOrThrow("git", ["checkout", "main"]);
  return { status: "opened", branch, url };
}

function printClusterHeader(cluster: Cluster): void {
  const tunable = INVOICE_SUPPLIERS.includes(cluster.supplier as never);
  const badge = tunable ? "" : "  [no supplier prompt — outbound/unknown, counts only]";
  console.log(`\n${"─".repeat(72)}`);
  console.log(`▶ ${cluster.supplier} · ${cluster.field} — ${cluster.corrections.length} corrections${badge}`);
}

function printDiagnosis(d: Diagnosis): void {
  console.log(`\n  ROOT CAUSE (${d.confidence} confidence):\n    ${d.root_cause.replace(/\n/g, "\n    ")}`);
  console.log(`\n  TARGET SECTION:\n    ${d.target_section.replace(/\n/g, "\n    ")}`);
  console.log(`\n  PROPOSED EDIT:\n    ${d.proposed_edit.replace(/\n/g, "\n    ")}`);
  console.log(`\n  REGRESSION RISK:\n    ${d.regression_risk.replace(/\n/g, "\n    ")}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corrections = await loadCorrections(args.limit);
  const clusters = clusterBySupplierField(corrections, args.minCluster, args.supplier);

  if (!args.json) {
    console.log(`Loaded ${corrections.length} corrections; ${clusters.length} cluster(s) at or above min-cluster=${args.minCluster}.`);
  }

  // Only fetch existing signatures when we might actually write.
  const existingSigs = args.writeSuggestions && !args.noLlm ? await loadPendingAgentSignatures() : new Set<string>();
  if (args.writeSuggestions && !args.json) {
    console.log(`Write mode ON — ${existingSigs.size} existing pending agent-tuner suggestion(s) will be skipped for dedupe.`);
  }

  const results: Array<Cluster & {
    diagnosis: Diagnosis | null;
    wrote: "written" | "skipped-dedupe" | "skipped-no-diagnosis" | "not-written";
    pr: PrResult | null;
  }> = [];
  let prsOpened = 0;
  for (const cluster of clusters) {
    let diagnosis: Diagnosis | null = null;
    if (!args.noLlm) {
      try {
        diagnosis = await diagnose(cluster, args.maxExamples);
      } catch (err) {
        if (!args.json) console.error(`  ! diagnosis failed for ${cluster.supplier}/${cluster.field}: ${(err as Error).message}`);
      }
    }

    let wrote: "written" | "skipped-dedupe" | "skipped-no-diagnosis" | "not-written" = "not-written";
    if (args.writeSuggestions && diagnosis) {
      const sig = suggestionSignature(cluster.supplier, cluster.field);
      if (existingSigs.has(sig)) {
        wrote = "skipped-dedupe";
      } else {
        const text = formatSuggestionText(cluster, diagnosis);
        const slipPhotoUrl = cluster.corrections[0]?.slipKey || null;
        try {
          await appendSuggestion({ supplier: cluster.supplier, slipPhotoUrl, text });
          await notifyAdmin({ supplier: cluster.supplier, field: cluster.field, count: cluster.corrections.length, text, slipPhotoUrl });
          existingSigs.add(sig);
          wrote = "written";
        } catch (err) {
          if (!args.json) console.error(`  ! write failed for ${cluster.supplier}/${cluster.field}: ${(err as Error).message}`);
        }
      }
    } else if (args.writeSuggestions && !diagnosis) {
      wrote = "skipped-no-diagnosis";
    }

    let pr: PrResult | null = null;
    if (args.openPr && diagnosis) {
      if (prsOpened >= args.maxPrs) {
        pr = { status: "skipped", reason: `--max-prs limit (${args.maxPrs}) reached for this run` };
      } else {
        try {
          pr = await openTunerPr({ cluster, diagnosis, dryRun: args.prDryRun });
          if (pr.status === "opened") prsOpened++;
        } catch (err) {
          pr = { status: "skipped", reason: `open PR failed: ${(err as Error).message}` };
        }
      }
    }

    results.push({ ...cluster, diagnosis, wrote, pr });

    if (!args.json) {
      printClusterHeader(cluster);
      if (diagnosis) printDiagnosis(diagnosis);
      else if (!args.noLlm) console.log(`  (no auto-diagnosis — no tunable supplier prompt for this cluster)`);
      if (args.writeSuggestions) {
        const label = wrote === "written" ? "✅ suggestion filed + admin DM sent"
          : wrote === "skipped-dedupe" ? "⏭ skipped (pending suggestion already exists)"
          : wrote === "skipped-no-diagnosis" ? "⏭ skipped (no diagnosis)"
          : "";
        if (label) console.log(`\n  ${label}`);
      }
      if (args.openPr && pr) {
        const label = pr.status === "opened"
          ? `🚀 PR opened: ${pr.url} (branch ${pr.branch})`
          : `⏭ PR skipped: ${pr.reason}`;
        console.log(`\n  ${label}`);
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify(results.map((r) => ({
      supplier: r.supplier, field: r.field, count: r.corrections.length,
      diagnosis: r.diagnosis, wrote: r.wrote, pr: r.pr
    })), null, 2));
  } else {
    const written = results.filter((r) => r.wrote === "written").length;
    const dedup = results.filter((r) => r.wrote === "skipped-dedupe").length;
    const prOpened = results.filter((r) => r.pr?.status === "opened").length;
    const prSkipped = results.filter((r) => r.pr?.status === "skipped").length;
    const lines: string[] = [];
    if (args.writeSuggestions) lines.push(`${written} suggestion(s) filed, ${dedup} skipped as duplicates.`);
    if (args.openPr)           lines.push(`${prOpened} PR(s) opened, ${prSkipped} skipped.`);
    if (lines.length === 0)    lines.push(`Nothing was written — review the proposals above, then rerun with --write-suggestions and/or --open-pr.`);
    console.log(`\n${"─".repeat(72)}\nDone. ${lines.join(" ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
