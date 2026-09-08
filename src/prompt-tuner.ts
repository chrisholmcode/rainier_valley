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
//   npm run tune:prompts -- --no-orchestrate      # skip the orchestrator pass — file every
//                                                 # raw diagnosis without meta-review. Escape
//                                                 # hatch for A/B comparison; orchestrator is
//                                                 # ON by default.

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
  noOrchestrate: boolean;
};

function parseArgs(argv: string[]): Args {
  const envWrite = process.env.TUNER_WRITE_SUGGESTIONS === "1" || process.env.TUNER_WRITE_SUGGESTIONS === "true";
  const envOpenPr = process.env.TUNER_OPEN_PR === "1" || process.env.TUNER_OPEN_PR === "true";
  const envNoOrch = process.env.TUNER_NO_ORCHESTRATE === "1" || process.env.TUNER_NO_ORCHESTRATE === "true";
  const a: Args = {
    limit: 500, minCluster: 2, supplier: null, noLlm: false, json: false, maxExamples: 5,
    writeSuggestions: envWrite,
    openPr: envOpenPr, maxPrs: 3, prDryRun: false,
    noOrchestrate: envNoOrch
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
    else if (arg === "--no-orchestrate") a.noOrchestrate = true;
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
    // First real run (2026-07-22) truncated at 1500 — Claude's diagnoses on
    // 50+-correction clusters routinely need 2–3k tokens. Bumped so required
    // schema fields (regression_risk, confidence) aren't silently dropped.
    max_tokens: 4000,
    tools: [{ name: DIAGNOSE_TOOL, description: "Submit the prompt-tuning diagnosis and proposed edit.", input_schema: DIAGNOSE_SCHEMA as never }],
    tool_choice: { type: "tool", name: DIAGNOSE_TOOL },
    messages: [{ role: "user", content: userPrompt }]
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  const input = toolUse.input as Partial<Diagnosis>;
  // If truncation still drops a required field, treat the diagnosis as
  // invalid — better to skip the cluster than open a PR from a stub.
  const required: Array<keyof Diagnosis> = ["root_cause", "target_section", "proposed_edit", "regression_risk", "confidence"];
  for (const key of required) {
    if (typeof input[key] !== "string" || (input[key] as string).length === 0) return null;
  }
  return input as Diagnosis;
}

// ── Orchestrator pass (default ON, opt-out with --no-orchestrate) ──────────
//
// After every cluster has been diagnosed in isolation, one meta-call sees ALL
// diagnoses together plus the current text of every touched supplier prompt
// file and any pending agent-tuner suggestions on the same (supplier,field)
// pairs. Its job is to catch failure modes that a single-cluster diagnosis
// can't see: contradictions across diagnoses, symptoms that are really a
// classifier/routing issue, edits that drift from the stated root cause, and
// same-file diagnoses that should be merged into one clean PR.
//
// Per decision, the orchestrator emits one of:
//   - keep    → diagnosis stands, flows through the normal write/PR pipeline
//   - drop    → diagnosis suppressed; a `rejected` row is appended to Prompt
//               Suggestions under submitted_by=agent-orchestrator so drops
//               are auditable in `/review?tab=suggestions`
//   - revise  → orchestrator supplies a replacement diagnosis, which then
//               flows through the keep pipeline
//   - bundle  → grouped with other bundle-tagged diagnoses that target the
//               same supplier prompt file; a second `mergeBundle` call emits
//               one clean search/replace for the group, which then flows
//               through the keep pipeline as a single suggestion + single PR

const ORCHESTRATOR_TOOL = "submit_orchestrator_decisions";
const ORCHESTRATOR_SCHEMA = {
  type: "object",
  properties: {
    decisions: {
      type: "array",
      description: "One decision per input diagnosis, indexed by the same `id` shown in the prompt.",
      items: {
        type: "object",
        properties: {
          id: { type: "number", description: "The 0-based index of the diagnosis this decision applies to." },
          action: { type: "string", enum: ["keep", "drop", "revise", "bundle"] },
          reason: { type: "string", description: "Concise justification for the chosen action. For drops, this is the visible audit note. Always required." },
          bundle_group: { type: "string", description: "For action=bundle only: a short identifier (e.g. \"weight-fields\") shared across every diagnosis that should merge into one PR. All members MUST target the same supplier prompt file — cross-supplier bundles are invalid and will be unbundled." },
          revised_root_cause: { type: "string", description: "For action=revise only." },
          revised_target_section: { type: "string", description: "For action=revise only." },
          revised_proposed_edit: { type: "string", description: "For action=revise only." },
          revised_regression_risk: { type: "string", description: "For action=revise only." },
          revised_confidence: { type: "string", enum: ["high", "medium", "low"], description: "For action=revise only." },
          revised_search_text: { type: "string", description: "For action=revise only. Same rules as diagnose: exactly one match, blank if not automatable." },
          revised_replace_text: { type: "string", description: "For action=revise only. Blank whenever revised_search_text is blank." }
        },
        required: ["id", "action", "reason"]
      }
    }
  },
  required: ["decisions"]
} as const;

type OrchestratorAction = "keep" | "drop" | "revise" | "bundle";
type RawDecision = {
  id: number; action: OrchestratorAction; reason: string;
  bundle_group?: string;
  revised_root_cause?: string; revised_target_section?: string;
  revised_proposed_edit?: string; revised_regression_risk?: string;
  revised_confidence?: string;
  revised_search_text?: string; revised_replace_text?: string;
};

type Decision =
  | { id: number; action: "keep"; reason: string }
  | { id: number; action: "drop"; reason: string }
  | { id: number; action: "revise"; reason: string; revised: Diagnosis }
  | { id: number; action: "bundle"; reason: string; bundleGroup: string };

function renderDiagnosisForOrchestrator(item: { cluster: Cluster; diagnosis: Diagnosis }, id: number): string {
  const d = item.diagnosis;
  const supplierFile = INVOICE_SUPPLIERS.includes(item.cluster.supplier as never)
    ? `prompts/invoice/suppliers/${item.cluster.supplier}.md` : "(no tunable file)";
  const swap = (d.search_text ?? "").trim().length > 0
    ? `search_text: |\n${(d.search_text ?? "").split("\n").map((l) => `  ${l}`).join("\n")}\nreplace_text: |\n${(d.replace_text ?? "").split("\n").map((l) => `  ${l}`).join("\n")}`
    : "(no automatable search/replace — Claude declined)";
  return [
    `=== id ${id} ===`,
    `supplier: ${item.cluster.supplier}  field: ${item.cluster.field}  cluster_size: ${item.cluster.corrections.length}  confidence: ${d.confidence}`,
    `file: ${supplierFile}`,
    `root_cause: ${d.root_cause}`,
    `target_section: ${d.target_section}`,
    `proposed_edit: ${d.proposed_edit}`,
    `regression_risk: ${d.regression_risk}`,
    swap
  ].join("\n");
}

async function orchestrate(
  items: Array<{ cluster: Cluster; diagnosis: Diagnosis }>,
  pendingAgentSigs: Set<string>
): Promise<Decision[]> {
  // Load every supplier prompt file this batch touches, once each.
  const filesTouched = new Map<string, string>();
  for (const item of items) {
    if (!INVOICE_SUPPLIERS.includes(item.cluster.supplier as never)) continue;
    const path = SUPPLIER_PROMPT(item.cluster.supplier);
    if (filesTouched.has(item.cluster.supplier)) continue;
    if (!existsSync(path)) continue;
    filesTouched.set(item.cluster.supplier, readFileSync(path, "utf8"));
  }

  const diagnosesBlock = items.map((it, id) => renderDiagnosisForOrchestrator(it, id)).join("\n\n");
  const filesBlock = Array.from(filesTouched.entries()).map(([supplier, body]) =>
    `--- BEGIN prompts/invoice/suppliers/${supplier}.md ---\n${body}\n--- END prompts/invoice/suppliers/${supplier}.md ---`
  ).join("\n\n");
  const pendingBlock = pendingAgentSigs.size === 0
    ? "(none)"
    : Array.from(pendingAgentSigs).map((s) => `- ${s}`).join("\n");

  const userPrompt = `You are the orchestrator for a batch of prompt-tuning diagnoses. Each was generated in isolation from one cluster of reviewer corrections. Your job is to ensure the batch — as a whole — makes sense before any of it becomes a Prompt Suggestion or a PR.

For each diagnosis, choose exactly one action:
- "keep": diagnosis is correct, minimal, and stands on its own. It will be filed as-is.
- "drop": diagnosis should NOT proceed. Common reasons: (a) it's a symptom of a routing/classifier issue and no supplier-prompt edit will fix it, (b) it contradicts another diagnosis in this batch or a pending agent-tuner suggestion, (c) the proposed_edit drifts from the stated root_cause, (d) the change would clearly regress unrelated slips. Always include a specific reason — it becomes the visible audit note.
- "revise": diagnosis is on the right track but must be reworked. Provide the FULL replacement fields (revised_root_cause, revised_target_section, revised_proposed_edit, revised_regression_risk, revised_confidence, and if possible revised_search_text + revised_replace_text). The revision will proceed as if it were the original.
- "bundle": diagnosis should merge with other bundle-tagged diagnoses into a single PR. Use bundle_group to share an identifier across every member. **Bundles are only valid when all members target the same supplier prompt file** — cross-supplier bundles will be unbundled back to "keep". Prefer bundling only when the proposed edits touch adjacent or overlapping regions of the same file.

Be conservative on drops: only drop when you can name a concrete failure. Be conservative on bundles: only bundle when a single coherent edit is clearly possible.

Diagnoses to review (${items.length} total):

${diagnosesBlock}

Current supplier prompt files touched by this batch:

${filesBlock}

Pending agent-tuner suggestions already on the sheet for these (supplier,field) pairs:
${pendingBlock}

Call ${ORCHESTRATOR_TOOL} with exactly one decision per diagnosis, indexed by \`id\`.`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 8000,
    tools: [{ name: ORCHESTRATOR_TOOL, description: "Submit per-diagnosis orchestrator decisions for the batch.", input_schema: ORCHESTRATOR_SCHEMA as never }],
    tool_choice: { type: "tool", name: ORCHESTRATOR_TOOL },
    messages: [{ role: "user", content: userPrompt }]
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    console.warn("orchestrator: no tool_use in response; falling back to keep-all");
    return items.map((_, id) => ({ id, action: "keep" as const, reason: "orchestrator returned no tool_use" }));
  }
  const raw = ((toolUse.input as { decisions?: RawDecision[] }).decisions ?? []);
  const byId = new Map<number, RawDecision>();
  for (const d of raw) byId.set(d.id, d);

  // Detect cross-supplier bundle groups and demote them to keep.
  const bundleSuppliers = new Map<string, Set<string>>();
  for (const d of raw) {
    if (d.action !== "bundle" || !d.bundle_group) continue;
    const item = items[d.id];
    if (!item) continue;
    if (!bundleSuppliers.has(d.bundle_group)) bundleSuppliers.set(d.bundle_group, new Set());
    bundleSuppliers.get(d.bundle_group)!.add(item.cluster.supplier);
  }
  const invalidBundles = new Set<string>();
  for (const [group, suppliers] of bundleSuppliers) {
    if (suppliers.size > 1) invalidBundles.add(group);
  }

  const decisions: Decision[] = items.map((_, id) => {
    const raw = byId.get(id);
    if (!raw) return { id, action: "keep" as const, reason: "orchestrator omitted this id; defaulted to keep" };
    if (raw.action === "keep") return { id, action: "keep", reason: raw.reason || "kept" };
    if (raw.action === "drop") return { id, action: "drop", reason: raw.reason || "(no reason given)" };
    if (raw.action === "bundle") {
      const group = raw.bundle_group?.trim();
      if (!group) return { id, action: "keep", reason: "orchestrator marked bundle with no bundle_group; defaulted to keep" };
      if (invalidBundles.has(group)) return { id, action: "keep", reason: `orchestrator proposed cross-supplier bundle "${group}"; demoted to keep` };
      return { id, action: "bundle", reason: raw.reason || "bundled", bundleGroup: group };
    }
    // revise: require the full set of fields (search/replace optional)
    const required: Array<keyof RawDecision> = [
      "revised_root_cause", "revised_target_section", "revised_proposed_edit",
      "revised_regression_risk", "revised_confidence"
    ];
    for (const key of required) {
      if (typeof raw[key] !== "string" || !((raw[key] as string).length > 0)) {
        return { id, action: "keep", reason: `orchestrator marked revise but missing field "${key}"; defaulted to keep` };
      }
    }
    const revised: Diagnosis = {
      root_cause: raw.revised_root_cause!,
      target_section: raw.revised_target_section!,
      proposed_edit: raw.revised_proposed_edit!,
      regression_risk: raw.revised_regression_risk!,
      confidence: raw.revised_confidence!,
      search_text: raw.revised_search_text ?? "",
      replace_text: raw.revised_replace_text ?? ""
    };
    return { id, action: "revise", reason: raw.reason || "revised", revised };
  });

  return decisions;
}

// Second orchestrator call: given a set of bundled diagnoses that target the
// same supplier prompt file, ask Claude to emit ONE clean, minimal edit that
// addresses all of them. If a single clean swap isn't possible, Claude may
// leave search_text/replace_text blank — the bundle will still be filed as a
// suggestion but won't auto-open a PR.
const MERGE_TOOL = "submit_merged_edit";
const MERGE_SCHEMA = DIAGNOSE_SCHEMA;

async function mergeBundle(params: {
  supplier: string;
  filePath: string;
  members: Array<{ cluster: Cluster; diagnosis: Diagnosis; id: number }>;
  groupLabel: string;
}): Promise<Diagnosis | null> {
  const current = readFileSync(params.filePath, "utf8");
  const membersBlock = params.members.map(({ cluster, diagnosis, id }) =>
    [
      `=== id ${id} (field: ${cluster.field}, ${cluster.corrections.length} corrections, confidence: ${diagnosis.confidence}) ===`,
      `root_cause: ${diagnosis.root_cause}`,
      `target_section: ${diagnosis.target_section}`,
      `proposed_edit: ${diagnosis.proposed_edit}`,
      `regression_risk: ${diagnosis.regression_risk}`
    ].join("\n")
  ).join("\n\n");

  const userPrompt = `The orchestrator bundled ${params.members.length} prompt-tuning diagnoses (group "${params.groupLabel}") that all target the same supplier prompt file. Emit ONE clean, minimal edit that addresses ALL of them.

Supplier: ${params.supplier}
File: prompts/invoice/suppliers/${params.supplier}.md

--- BEGIN PROMPT ---
${current}
--- END PROMPT ---

Bundled diagnoses:

${membersBlock}

Rules:
- Prefer a SINGLE search_text/replace_text pair that resolves every member's failure mode.
- search_text must match the file EXACTLY ONCE (byte-for-byte, whitespace preserved). Include enough surrounding context if the natural target appears multiple times.
- Keep the edit minimal and localized. Don't rewrite whole sections.
- If a single clean edit is NOT possible (e.g. members touch non-adjacent parts of the file), leave search_text and replace_text empty. root_cause should then explain why the bundle needs a manual restructure.

Then call ${MERGE_TOOL} with the merged diagnosis.`;

  const response = await client.messages.create({
    model: env.ANTHROPIC_MODEL,
    max_tokens: 4000,
    tools: [{ name: MERGE_TOOL, description: "Submit the merged edit for a bundled group of diagnoses.", input_schema: MERGE_SCHEMA as never }],
    tool_choice: { type: "tool", name: MERGE_TOOL },
    messages: [{ role: "user", content: userPrompt }]
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;
  const input = toolUse.input as Partial<Diagnosis>;
  const required: Array<keyof Diagnosis> = ["root_cause", "target_section", "proposed_edit", "regression_risk", "confidence"];
  for (const key of required) {
    if (typeof input[key] !== "string" || (input[key] as string).length === 0) return null;
  }
  return input as Diagnosis;
}

function bundledFieldLabel(fields: string[]): string {
  // Deterministic label so signatures and branch names are stable across runs.
  return [...new Set(fields)].sort().join("+");
}

// ── Prompt Suggestions write path (opt-in, --write-suggestions) ─────────────
//
// Mirrors sheets.ts::appendPromptSuggestion column layout deliberately — this
// script never imports from the CODEOWNERS-gated sheets.ts to keep the tuning
// loop's blast radius bounded.
const SUGGESTED_BY = "agent-tuner";
const ORCHESTRATOR_SUBMITTED_BY = "agent-orchestrator";
const P = { created_at: 0, submitted_by: 1, supplier: 2, slip_photo_url: 3, suggestion_text: 4, status: 5 };

function suggestionSignature(supplier: string, field: string): string {
  return `agent-tuner:${supplier}:${field}`;
}

function formatSuggestionText(cluster: Cluster, d: Diagnosis): string {
  // The signature comment lets us dedupe: on subsequent runs we skip any
  // (supplier,field) that already has a pending agent-tuner suggestion.
  const sig = suggestionSignature(cluster.supplier, cluster.field);
  return formatBundleOrSingleText({ signature: sig, field: cluster.field, count: cluster.corrections.length, diagnosis: d });
}

function formatBundleOrSingleText(params: {
  signature: string;
  field: string;
  count: number;
  diagnosis: Diagnosis;
  bundleGroup?: string;
}): string {
  const header = params.bundleGroup
    ? `**Bundle:** \`${params.bundleGroup}\` · **Fields:** \`${params.field}\` · **Corrections merged:** ${params.count} · **Confidence:** ${params.diagnosis.confidence}`
    : `**Field:** \`${params.field}\` · **Corrections in cluster:** ${params.count} · **Confidence:** ${params.diagnosis.confidence}`;
  return [
    `<!-- signature: ${params.signature} -->`,
    header,
    ``,
    `**Root cause**`,
    params.diagnosis.root_cause,
    ``,
    `**Target section**`,
    params.diagnosis.target_section,
    ``,
    `**Proposed edit**`,
    params.diagnosis.proposed_edit,
    ``,
    `**Regression risk**`,
    params.diagnosis.regression_risk
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

// ── Orchestrator rejection audit rows ──────────────────────────────────────
//
// When the orchestrator drops a diagnosis, we append a `rejected` row under
// submitted_by=agent-orchestrator so the drop is visible + auditable in
// /review?tab=suggestions. Deduped on rejection signature so repeat runs don't
// re-file the same drop. To force reconsideration, delete the rejection row.

function rejectionSignature(supplier: string, field: string): string {
  return `agent-orchestrator:reject:${supplier}:${field}`;
}

async function loadOrchestratorRejectionSignatures(): Promise<Set<string>> {
  const rows = await readTab(env.PROMPT_SUGGESTIONS_WORKSHEET_NAME, "A2:I").catch(() => [] as string[][]);
  const sigs = new Set<string>();
  for (const r of rows) {
    if ((r[P.submitted_by] ?? "") !== ORCHESTRATOR_SUBMITTED_BY) continue;
    const text = r[P.suggestion_text] ?? "";
    const m = text.match(/<!-- signature:\s*(\S+?)\s*-->/);
    if (m) sigs.add(m[1]);
  }
  return sigs;
}

function formatRejectionText(cluster: Cluster, d: Diagnosis, reason: string): string {
  const sig = rejectionSignature(cluster.supplier, cluster.field);
  return [
    `<!-- signature: ${sig} -->`,
    `**Field:** \`${cluster.field}\` · **Corrections in cluster:** ${cluster.corrections.length} · **Original confidence:** ${d.confidence}`,
    ``,
    `**Orchestrator drop reason**`,
    reason,
    ``,
    `**Original root cause**`,
    d.root_cause,
    ``,
    `**Original proposed edit**`,
    d.proposed_edit
  ].join("\n");
}

async function appendRejection(params: { supplier: string; slipPhotoUrl: string | null; text: string }): Promise<void> {
  const createdAt = new Date().toISOString();
  const row = [createdAt, ORCHESTRATOR_SUBMITTED_BY, params.supplier, params.slipPhotoUrl ?? "", params.text, "rejected", "", "", ""];
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SPREADSHEET_ID,
    range: `${env.PROMPT_SUGGESTIONS_WORKSHEET_NAME}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
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

function printClusterHeader(supplier: string, field: string, count: number, tunable: boolean, badgeExtra?: string): void {
  const badge = tunable ? "" : "  [no supplier prompt — outbound/unknown, counts only]";
  const extra = badgeExtra ? `  ${badgeExtra}` : "";
  console.log(`\n${"─".repeat(72)}`);
  console.log(`▶ ${supplier} · ${field} — ${count} corrections${badge}${extra}`);
}

function printDiagnosis(d: Diagnosis): void {
  console.log(`\n  ROOT CAUSE (${d.confidence} confidence):\n    ${d.root_cause.replace(/\n/g, "\n    ")}`);
  console.log(`\n  TARGET SECTION:\n    ${d.target_section.replace(/\n/g, "\n    ")}`);
  console.log(`\n  PROPOSED EDIT:\n    ${d.proposed_edit.replace(/\n/g, "\n    ")}`);
  console.log(`\n  REGRESSION RISK:\n    ${d.regression_risk.replace(/\n/g, "\n    ")}`);
}

type WriteStatus = "written" | "skipped-dedupe" | "skipped-no-diagnosis" | "rejection-written" | "rejection-skipped-dedupe" | "merge-failed" | "not-written";

type Outcome = {
  supplier: string;
  field: string;
  count: number;
  kind: "single" | "bundle-leader" | "bundle-member";
  orchestrator: { action: OrchestratorAction; reason: string } | null;
  bundleGroup?: string;
  bundleMemberIds?: number[];
  diagnosis: Diagnosis | null;
  wrote: WriteStatus;
  pr: PrResult | null;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corrections = await loadCorrections(args.limit);
  const clusters = clusterBySupplierField(corrections, args.minCluster, args.supplier);

  if (!args.json) {
    console.log(`Loaded ${corrections.length} corrections; ${clusters.length} cluster(s) at or above min-cluster=${args.minCluster}.`);
    console.log(`Orchestrator: ${args.noOrchestrate ? "OFF (raw diagnoses will be filed directly)" : "ON (default)"}.`);
  }

  const willWrite = args.writeSuggestions && !args.noLlm;
  const existingSigs = willWrite ? await loadPendingAgentSignatures() : new Set<string>();
  const rejectionSigs = willWrite ? await loadOrchestratorRejectionSignatures() : new Set<string>();
  if (willWrite && !args.json) {
    console.log(`Write mode ON — ${existingSigs.size} pending agent-tuner suggestion(s) and ${rejectionSigs.size} orchestrator rejection(s) will be skipped for dedupe.`);
  }

  // ── Phase 1: diagnose every cluster in isolation ───────────────────────
  type DiagnosedItem = { cluster: Cluster; diagnosis: Diagnosis };
  const diagnosed: DiagnosedItem[] = [];
  const undiagnosed: Cluster[] = [];
  for (const cluster of clusters) {
    if (args.noLlm) { undiagnosed.push(cluster); continue; }
    let diagnosis: Diagnosis | null = null;
    try {
      diagnosis = await diagnose(cluster, args.maxExamples);
    } catch (err) {
      if (!args.json) console.error(`  ! diagnosis failed for ${cluster.supplier}/${cluster.field}: ${(err as Error).message}`);
    }
    if (diagnosis) diagnosed.push({ cluster, diagnosis });
    else undiagnosed.push(cluster);
  }

  // ── Phase 2: orchestrator meta-review ──────────────────────────────────
  let decisions: Decision[];
  if (args.noOrchestrate || diagnosed.length === 0) {
    decisions = diagnosed.map((_, id) => ({ id, action: "keep" as const, reason: args.noOrchestrate ? "orchestrator disabled" : "orchestrator skipped (no diagnoses)" }));
  } else {
    try {
      decisions = await orchestrate(diagnosed, existingSigs);
    } catch (err) {
      if (!args.json) console.error(`  ! orchestrator failed; falling back to keep-all: ${(err as Error).message}`);
      decisions = diagnosed.map((_, id) => ({ id, action: "keep" as const, reason: "orchestrator errored; kept" }));
    }
  }

  // ── Phase 3: execute per decision ──────────────────────────────────────
  // Group bundle decisions by (supplier, bundleGroup). Orphan groups (size 1)
  // are demoted to keep so we never hold up a single-member "bundle."
  const bundleGroups = new Map<string, { supplier: string; group: string; memberIds: number[] }>();
  for (const dec of decisions) {
    if (dec.action !== "bundle") continue;
    const item = diagnosed[dec.id];
    const key = `${item.cluster.supplier}::${dec.bundleGroup}`;
    if (!bundleGroups.has(key)) bundleGroups.set(key, { supplier: item.cluster.supplier, group: dec.bundleGroup, memberIds: [] });
    bundleGroups.get(key)!.memberIds.push(dec.id);
  }
  const orphanIds = new Set<number>();
  for (const [key, grp] of bundleGroups) {
    if (grp.memberIds.length < 2) {
      for (const id of grp.memberIds) orphanIds.add(id);
      bundleGroups.delete(key);
    }
  }

  const outcomes: Outcome[] = [];
  let prsOpened = 0;

  const writeAndPr = async (opts: {
    supplier: string; field: string; count: number;
    diagnosis: Diagnosis;
    slipPhotoUrl: string | null;
    signature: string;
    kind: Outcome["kind"];
    orchestrator: Outcome["orchestrator"];
    bundleGroup?: string;
    bundleMemberIds?: number[];
    clusterForPr: Cluster;   // Cluster shape passed to openTunerPr (supplier + field + corrections length)
  }): Promise<Outcome> => {
    let wrote: WriteStatus = "not-written";
    if (args.writeSuggestions) {
      if (existingSigs.has(opts.signature)) {
        wrote = "skipped-dedupe";
      } else {
        const text = formatBundleOrSingleText({ signature: opts.signature, field: opts.field, count: opts.count, diagnosis: opts.diagnosis, bundleGroup: opts.bundleGroup });
        try {
          await appendSuggestion({ supplier: opts.supplier, slipPhotoUrl: opts.slipPhotoUrl, text });
          await notifyAdmin({ supplier: opts.supplier, field: opts.field, count: opts.count, text, slipPhotoUrl: opts.slipPhotoUrl });
          existingSigs.add(opts.signature);
          wrote = "written";
        } catch (err) {
          if (!args.json) console.error(`  ! write failed for ${opts.supplier}/${opts.field}: ${(err as Error).message}`);
        }
      }
    }
    let pr: PrResult | null = null;
    if (args.openPr) {
      if (prsOpened >= args.maxPrs) {
        pr = { status: "skipped", reason: `--max-prs limit (${args.maxPrs}) reached for this run` };
      } else {
        try {
          pr = await openTunerPr({ cluster: opts.clusterForPr, diagnosis: opts.diagnosis, dryRun: args.prDryRun });
          if (pr.status === "opened") prsOpened++;
        } catch (err) {
          pr = { status: "skipped", reason: `open PR failed: ${(err as Error).message}` };
        }
      }
    }
    return {
      supplier: opts.supplier, field: opts.field, count: opts.count,
      kind: opts.kind, orchestrator: opts.orchestrator,
      bundleGroup: opts.bundleGroup, bundleMemberIds: opts.bundleMemberIds,
      diagnosis: opts.diagnosis, wrote, pr
    };
  };

  // Process singles first (keeps + revises + demoted orphans), then bundles.
  for (const dec of decisions) {
    const item = diagnosed[dec.id];
    const isOrphan = orphanIds.has(dec.id);
    const effective = isOrphan
      ? { ...dec, action: "keep" as const, reason: `${dec.reason} (orphan bundle demoted to keep)` }
      : dec;

    if (effective.action === "bundle") continue; // handled below

    if (effective.action === "drop") {
      const sig = rejectionSignature(item.cluster.supplier, item.cluster.field);
      let wrote: WriteStatus = "not-written";
      if (args.writeSuggestions) {
        if (rejectionSigs.has(sig)) {
          wrote = "rejection-skipped-dedupe";
        } else {
          try {
            const text = formatRejectionText(item.cluster, item.diagnosis, effective.reason);
            const slipPhotoUrl = item.cluster.corrections[0]?.slipKey || null;
            await appendRejection({ supplier: item.cluster.supplier, slipPhotoUrl, text });
            rejectionSigs.add(sig);
            wrote = "rejection-written";
          } catch (err) {
            if (!args.json) console.error(`  ! rejection write failed for ${item.cluster.supplier}/${item.cluster.field}: ${(err as Error).message}`);
          }
        }
      }
      outcomes.push({
        supplier: item.cluster.supplier, field: item.cluster.field, count: item.cluster.corrections.length,
        kind: "single", orchestrator: { action: "drop", reason: effective.reason },
        diagnosis: item.diagnosis, wrote, pr: null
      });
      continue;
    }

    const finalDiagnosis = effective.action === "revise" ? effective.revised : item.diagnosis;
    const orchestratorRecord = { action: effective.action, reason: effective.reason };
    const outcome = await writeAndPr({
      supplier: item.cluster.supplier,
      field: item.cluster.field,
      count: item.cluster.corrections.length,
      diagnosis: finalDiagnosis,
      slipPhotoUrl: item.cluster.corrections[0]?.slipKey || null,
      signature: suggestionSignature(item.cluster.supplier, item.cluster.field),
      kind: "single",
      orchestrator: orchestratorRecord,
      clusterForPr: item.cluster
    });
    outcomes.push(outcome);
  }

  // Bundles: one merge call per group, then one write/PR per group.
  for (const grp of bundleGroups.values()) {
    const members = grp.memberIds.map((id) => ({ ...diagnosed[id], id }));
    const path = SUPPLIER_PROMPT(grp.supplier);
    let merged: Diagnosis | null = null;
    try {
      merged = await mergeBundle({ supplier: grp.supplier, filePath: path, members, groupLabel: grp.group });
    } catch (err) {
      if (!args.json) console.error(`  ! merge failed for bundle ${grp.supplier}/${grp.group}: ${(err as Error).message}`);
    }
    const fields = members.map((m) => m.cluster.field);
    const combinedField = bundledFieldLabel(fields);
    const totalCount = members.reduce((s, m) => s + m.cluster.corrections.length, 0);
    const signature = `agent-tuner:${grp.supplier}:bundle:${combinedField}`;

    if (!merged) {
      outcomes.push({
        supplier: grp.supplier, field: `bundle:${combinedField}`, count: totalCount,
        kind: "bundle-leader",
        orchestrator: { action: "bundle", reason: `bundle "${grp.group}"` },
        bundleGroup: grp.group, bundleMemberIds: grp.memberIds,
        diagnosis: null, wrote: "merge-failed", pr: null
      });
    } else {
      const syntheticCluster: Cluster = {
        supplier: grp.supplier,
        field: `bundle-${combinedField}`,
        corrections: members.flatMap((m) => m.cluster.corrections)
      };
      const outcome = await writeAndPr({
        supplier: grp.supplier, field: `bundle:${combinedField}`, count: totalCount,
        diagnosis: merged,
        slipPhotoUrl: members[0].cluster.corrections[0]?.slipKey || null,
        signature,
        kind: "bundle-leader",
        orchestrator: { action: "bundle", reason: `bundle "${grp.group}"` },
        bundleGroup: grp.group, bundleMemberIds: grp.memberIds,
        clusterForPr: syntheticCluster
      });
      outcomes.push(outcome);
    }
    // Add member breadcrumbs for the console + JSON audit trail
    for (const m of members) {
      outcomes.push({
        supplier: m.cluster.supplier, field: m.cluster.field, count: m.cluster.corrections.length,
        kind: "bundle-member",
        orchestrator: { action: "bundle", reason: `merged into bundle "${grp.group}"` },
        bundleGroup: grp.group,
        diagnosis: m.diagnosis, wrote: "not-written", pr: null
      });
    }
  }

  // Undiagnosed clusters → note them so the audit trail is complete.
  for (const cluster of undiagnosed) {
    outcomes.push({
      supplier: cluster.supplier, field: cluster.field, count: cluster.corrections.length,
      kind: "single", orchestrator: null,
      diagnosis: null,
      wrote: args.writeSuggestions ? "skipped-no-diagnosis" : "not-written",
      pr: null
    });
  }

  // ── Print ──────────────────────────────────────────────────────────────
  if (args.json) {
    console.log(JSON.stringify(outcomes.map((o) => ({
      supplier: o.supplier, field: o.field, count: o.count, kind: o.kind,
      orchestrator: o.orchestrator, bundle_group: o.bundleGroup,
      bundle_member_ids: o.bundleMemberIds,
      diagnosis: o.diagnosis, wrote: o.wrote, pr: o.pr
    })), null, 2));
  } else {
    for (const o of outcomes) {
      const tunable = INVOICE_SUPPLIERS.includes(o.supplier as never);
      const badgeExtra = o.kind === "bundle-leader" ? `[bundle merged from ${o.bundleMemberIds?.length ?? 0} clusters]`
        : o.kind === "bundle-member" ? `[merged into bundle "${o.bundleGroup}"]`
        : o.orchestrator?.action === "drop" ? `[orchestrator DROP]`
        : o.orchestrator?.action === "revise" ? `[orchestrator REVISED]`
        : undefined;
      printClusterHeader(o.supplier, o.field, o.count, tunable, badgeExtra);
      if (o.orchestrator) {
        console.log(`\n  ORCHESTRATOR (${o.orchestrator.action.toUpperCase()}): ${o.orchestrator.reason}`);
      }
      if (o.kind === "bundle-member") continue; // member details are on the leader
      if (o.diagnosis) printDiagnosis(o.diagnosis);
      else if (o.wrote === "merge-failed") console.log(`  (bundle merge failed — no automatable edit was produced)`);
      else if (!args.noLlm && !o.orchestrator) console.log(`  (no auto-diagnosis — no tunable supplier prompt for this cluster)`);
      if (args.writeSuggestions) {
        const label = o.wrote === "written" ? "✅ suggestion filed + admin DM sent"
          : o.wrote === "skipped-dedupe" ? "⏭ skipped (pending suggestion already exists)"
          : o.wrote === "skipped-no-diagnosis" ? "⏭ skipped (no diagnosis)"
          : o.wrote === "rejection-written" ? "🗑 rejection audit row filed"
          : o.wrote === "rejection-skipped-dedupe" ? "⏭ rejection skipped (already audited on a prior run)"
          : o.wrote === "merge-failed" ? "⏭ bundle merge failed — nothing filed"
          : "";
        if (label) console.log(`\n  ${label}`);
      }
      if (args.openPr && o.pr) {
        const label = o.pr.status === "opened"
          ? `🚀 PR opened: ${o.pr.url} (branch ${o.pr.branch})`
          : `⏭ PR skipped: ${o.pr.reason}`;
        console.log(`\n  ${label}`);
      }
    }

    const written = outcomes.filter((o) => o.wrote === "written").length;
    const dedup = outcomes.filter((o) => o.wrote === "skipped-dedupe").length;
    const rejected = outcomes.filter((o) => o.wrote === "rejection-written").length;
    const rejectedDedup = outcomes.filter((o) => o.wrote === "rejection-skipped-dedupe").length;
    const bundles = outcomes.filter((o) => o.kind === "bundle-leader").length;
    const revised = outcomes.filter((o) => o.orchestrator?.action === "revise").length;
    const prOpened = outcomes.filter((o) => o.pr?.status === "opened").length;
    const prSkipped = outcomes.filter((o) => o.pr?.status === "skipped").length;
    const lines: string[] = [];
    if (!args.noOrchestrate) lines.push(`Orchestrator: ${bundles} bundle(s), ${revised} revision(s), ${rejected} drop(s) filed as audit rows (${rejectedDedup} dedup'd).`);
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
