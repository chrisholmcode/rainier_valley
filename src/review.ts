import type { DeliverySheetRow, PromptSuggestionRow } from "./types.js";
import type { SlipSummary } from "./sheets.js";
import { SHARED_CSS, FONT_HEAD_LINKS } from "./ui-styles.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function encodeSlipKey(slipKey: string): string {
  return Buffer.from(slipKey, "utf-8").toString("base64url");
}

export function decodeSlipKey(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf-8");
}

function statusBadge(slip: SlipSummary): string {
  if (slip.approved) {
    const humanApproved = slip.approvedBy && slip.approvedBy !== "auto-approved";
    return humanApproved
      ? `<span class="badge badge-human" title="Manually approved by ${escapeHtml(slip.approvedBy ?? "")}">human approved</span>`
      : `<span class="badge badge-approved">auto approved</span>`;
  }
  if (slip.flaggedForReview) return `<span class="badge badge-pending" title="Possible duplicate — see source_warnings">possible dupe</span>`;
  return `<span class="badge badge-pending">pending</span>`;
}

function confidenceBadge(min: number | null, threshold: number): string {
  if (min === null) return `<span class="muted">—</span>`;
  const pct = Math.round(min * 100);
  const cls = min < threshold ? "low" : "ok";
  return `<span class="conf conf-${cls}">${pct}%</span>`;
}

function donorOrSupplier(slip: SlipSummary): string {
  if (slip.donor_org && slip.donor_org.trim()) {
    return `${escapeHtml(slip.donor_org)} <span class="muted">via ${escapeHtml(slip.supplier)}</span>`;
  }
  return escapeHtml(slip.supplier);
}

const STYLE = `
${SHARED_CSS}

/* Review-specific */
.tabs { display:flex; gap:6px; flex-wrap:wrap; }
.search-bar { display:flex; align-items:center; gap:12px; margin:0 0 20px; }
.search-bar input[type="search"] {
  flex:1; padding:10px 14px;
  border:1px solid var(--line); border-radius: var(--radius-md);
  background:#fff; color: var(--ink);
  font-family: inherit; font-size:14px;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.search-bar input[type="search"]:focus {
  outline:none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg);
}
.search-count { font-size:12px; font-variant-numeric: tabular-nums; }
.suggestion-item { padding:16px 20px; border-bottom:1px solid var(--border); }
.suggestion-item:last-child { border-bottom:0; }
.suggestion-header { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:8px; }
.suggestion-body { white-space:pre-wrap; font-size:14px; color:var(--ink); }
.suggestion-actions { display:flex; gap:6px; flex-shrink:0; }
.prompt-view { max-height:340px; overflow:auto; background:var(--surface-alt, #f7f7f9); border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:8px 0 0; font-size:12px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }
a.slip-link { color: var(--ink); text-decoration: none; font-weight: 600; display:inline-flex; align-items:center; gap:4px; }
a.slip-link:hover { color: var(--primary); }
a.slip-link::after { content: ""; }

.section-title { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;
                 margin:36px 0 16px;
                 font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
                 font-size: 20px; font-weight: 700; letter-spacing: -0.02em;
                 text-transform: none; color: var(--ink); line-height: 1.2; }
.section-title:first-of-type { margin-top:0; }
.section-title-warn { color: var(--warn); }
.section-count { display:inline-flex; align-items:center; justify-content:center;
                 min-width:22px; height:22px; padding:0 8px;
                 border-radius: var(--radius-pill);
                 background: var(--line); color: var(--ink);
                 font-size: 12px; font-weight: 600;
                 font-variant-numeric: tabular-nums; letter-spacing: 0; }
.section-title-warn .section-count { background: var(--warn-bg); color: var(--warn); }
.section-sub { font-size: 13px; font-weight: 400; letter-spacing: 0;
               color: var(--muted); text-transform: none; }

/* Slip detail layout */
.layout-detail { display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(320px, 1fr); gap:16px; }
@media (max-width:1100px) { .layout-detail { grid-template-columns:1fr; } }
.photo-pane img, .photo-pane iframe { width:100%; height:auto; border-radius: var(--radius-md); border:1px solid var(--line); display:block; }
.photo-pane iframe { height:80vh; }
.photo-pane a { color: var(--primary); font-size:13px; word-break:break-all; text-decoration: none; }
.photo-pane a:hover { text-decoration: underline; }

.slip-meta { background:var(--card); border:1px solid var(--line); border-radius:var(--radius-lg);
             padding:20px; margin-bottom:16px; font-size:13px;
             box-shadow: 0 1px 0 rgba(50,50,93,0.025); }
.slip-meta dl { display:grid; grid-template-columns:160px 1fr; gap:10px 14px; margin:0; }
.slip-meta dt { color: var(--muted); font-weight:600; font-size:12px; padding-top: 8px;
                text-transform: uppercase; letter-spacing: 0.04em; }
.slip-meta dd { margin:0; font-variant-numeric:tabular-nums; }

/* Inputs */
input[type="text"], input[type="number"], select, textarea {
  width:100%; padding:8px 10px;
  border:1px solid var(--line); border-radius: var(--radius-sm);
  background:#fff; color: var(--ink);
  font-family: inherit; font-size:13px; line-height:1.4;
  font-variant-numeric:tabular-nums;
  transition: border-color 0.12s, box-shadow 0.12s;
}
input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
  outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg);
}
input.dirty, select.dirty { background: var(--warn-bg); }
.fee-row { background: #fdfbeb; }
/* Skeleton rows (no value on form / hatched-out category) — dimmed but fully editable. */
.row-blank td { opacity: 0.45; transition: opacity 0.15s; }
.row-blank td input, .row-blank td select { opacity: 1; }
.row-blank.row-touched td { opacity: 1; }

/* Editable line-items table — wider, with horizontal scroll */
.line-items-card { overflow-x: auto; }
table.line-items { min-width: 1800px; }
table.line-items th, table.line-items td { padding:8px 8px; }
table.line-items col.col-code       { width:  90px; }
table.line-items col.col-raw        { width: 170px; }
table.line-items col.col-normalized { width: 170px; }
table.line-items col.col-qty-ord    { width:  80px; }
table.line-items col.col-qty        { width:  80px; }
table.line-items col.col-qty-raw    { width:  90px; }
table.line-items col.col-pack       { width: 100px; }
table.line-items col.col-unit       { width:  95px; }
table.line-items col.col-category   { width: 135px; }
table.line-items col.col-weight     { width:  90px; }
table.line-items col.col-cost       { width:  90px; }
table.line-items col.col-total      { width:  90px; }
table.line-items col.col-fee        { width:  80px; }
table.line-items col.col-conf       { width:  80px; }
table.line-items col.col-notes      { width: 180px; }
table.line-items input, table.line-items select { min-width: 0; padding: 6px 8px; }

/* Toast */
.toast { position:fixed; bottom:24px; right:24px; padding:14px 20px;
         border-radius: var(--radius-md);
         background:var(--ink); color:#fff; font-size:13px; font-weight:600; z-index:1000;
         opacity:0; transform: translateY(8px);
         transition: opacity 0.18s, transform 0.18s; pointer-events:none;
         box-shadow: 0 4px 16px rgba(10,37,64,0.18); }
.toast.show { opacity:1; transform: translateY(0); }
.toast.error { background: var(--danger); }
`;

function renderSlipRow(s: SlipSummary, threshold: number): string {
  const enc = encodeSlipKey(s.slipKey);
  const uploaded = s.created_at
    ? escapeHtml(s.created_at.slice(0, 10))
    : `<span class="muted">—</span>`;
  const date = s.delivery_date || `<span class="muted">${escapeHtml(s.created_at.slice(0, 10))}</span>`;
  const invoice = s.invoice_or_order_number ? escapeHtml(s.invoice_or_order_number) : `<span class="muted">—</span>`;
  const approvedOn = s.approvedAt
    ? escapeHtml(s.approvedAt.slice(0, 10))
    : `<span class="muted">—</span>`;
  return `<tr>
    <td>${statusBadge(s)}</td>
    <td>${uploaded}</td>
    <td>${date}</td>
    <td>${donorOrSupplier(s)}</td>
    <td>${invoice}</td>
    <td class="num">${s.rowCount}</td>
    <td>${confidenceBadge(s.minConfidence, threshold)}</td>
    <td>${approvedOn}</td>
    <td><a class="slip-link" href="/review/slip?slip=${enc}">Open ›</a></td>
  </tr>`;
}

function renderSlipTable(slips: SlipSummary[], threshold: number): string {
  const body = slips.map((s) => renderSlipRow(s, threshold)).join("");
  return `<table>
    <thead><tr>
      <th>Status</th><th>Uploaded</th><th>Delivery date</th><th>Donor / Supplier</th><th>Invoice #</th>
      <th class="num">Rows</th><th>Min confidence</th><th>Approved</th><th></th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

export function buildReviewListHtml(params: {
  slips: SlipSummary[];
  pendingOnly: boolean;
  threshold: number;
  token: string;
  generatedAt: Date;
  pendingSuggestionCount: number;
}): string {
  const { slips, pendingOnly, threshold, generatedAt, pendingSuggestionCount } = params;

  // "Needs review" = not yet approved AND (below threshold OR flagged, e.g. possible duplicate).
  // Worst confidence first; flagged slips sort to the top.
  const needsReview = slips
    .filter((s) => !s.approved && (s.flaggedForReview || (s.minConfidence !== null && s.minConfidence < threshold)))
    .sort((a, b) => {
      if (a.flaggedForReview !== b.flaggedForReview) return a.flaggedForReview ? -1 : 1;
      return (a.minConfidence ?? 1) - (b.minConfidence ?? 1);
    });
  const completed = slips
    .filter((s) => !(!s.approved && (s.flaggedForReview || (s.minConfidence !== null && s.minConfidence < threshold))))
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));

  const queueCls = pendingOnly ? "btn active" : "btn";
  const historyCls = pendingOnly ? "btn" : "btn active";
  const generated = generatedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  const body = pendingOnly
    ? `
      <h2 class="section-title section-title-warn">
        Needs review
        <span class="section-count">${needsReview.length}</span>
        <span class="section-sub muted">confidence &lt; ${Math.round(threshold * 100)}% · resolve these first</span>
      </h2>
      <div class="card">
        ${needsReview.length === 0
          ? `<p class="muted" style="padding:24px; text-align:center;">Nothing to review — every slip is above ${Math.round(threshold * 100)}% confidence or already approved. 🎉</p>`
          : renderSlipTable(needsReview, threshold)}
      </div>

      <h2 class="section-title">
        Completed
        <span class="section-count">${completed.length}</span>
        <span class="section-sub muted">approved or above threshold · most recent first</span>
      </h2>
      <div class="card">
        ${completed.length === 0
          ? `<p class="muted" style="padding:24px; text-align:center;">No completed slips yet.</p>`
          : renderSlipTable(completed, threshold)}
      </div>`
    : `<div class="card">
        ${slips.length === 0
          ? `<p class="muted" style="padding:24px; text-align:center;">No slips found.</p>`
          : renderSlipTable(slips, threshold)}
      </div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>RVFB Review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${STYLE}</style>
</head><body><div class="container">
<header class="page">
  <div>
    <h1>RVFB Slip Review</h1>
    <div class="meta">${slips.length} slip${slips.length === 1 ? "" : "s"} · confidence threshold ${Math.round(threshold * 100)}% · ${escapeHtml(generated)} PT</div>
  </div>
  <div class="tabs">
    <a class="${queueCls}" href="/review?tab=queue">Review Queue</a>
    <a class="${historyCls}" href="/review?tab=history">All Slips</a>
    <a class="btn" href="/review?tab=suggestions">Prompt Suggestions${pendingSuggestionCount > 0 ? ` <span class="badge badge-pending" style="margin-left:6px;">${pendingSuggestionCount}</span>` : ""}</a>
    <a class="btn" href="/dashboard?view=daily&range=1w">← Dashboard</a>
  </div>
</header>
<div class="search-bar">
  <input type="search" id="slip-search" placeholder="Search slips — supplier, donor, invoice #, date…" autocomplete="off" oninput="filterSlips(this.value)">
  <span class="muted search-count" id="search-count"></span>
</div>
${body}
<footer>RVFB Inventory · Slip Review · Edit history in Corrections Log tab</footer>
</div>
<script>
function filterSlips(q) {
  const query = q.trim().toLowerCase();
  const tables = document.querySelectorAll('.card table');
  let totalVisible = 0;
  tables.forEach((tbl) => {
    const rows = tbl.querySelectorAll('tbody tr');
    rows.forEach((tr) => {
      const text = tr.textContent.toLowerCase();
      const match = !query || text.includes(query);
      tr.style.display = match ? '' : 'none';
      if (match) totalVisible++;
    });
  });
  const badge = document.getElementById('search-count');
  badge.textContent = query ? totalVisible + ' match' + (totalVisible === 1 ? '' : 'es') : '';
}
</script>
</body></html>`;
}

export function buildSuggestionsListHtml(params: {
  suggestions: PromptSuggestionRow[];
  currentEmail: string | null;
  isAdmin: boolean;
  pendingCount: number;
  generatedAt: Date;
}): string {
  const { suggestions, currentEmail, isAdmin, pendingCount, generatedAt } = params;
  const pending = suggestions.filter((s) => s.status === "pending");
  const resolved = suggestions.filter((s) => s.status !== "pending");
  const generated = generatedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  const renderRow = (s: PromptSuggestionRow) => {
    const when = (s.created_at || "").slice(0, 16).replace("T", " ");
    const actions = isAdmin && s.status === "pending"
      ? `<div class="suggestion-actions">
          <button class="btn btn-primary" onclick="resolveSuggestion(${s.rowIndex}, 'approved')">Approve</button>
          <button class="btn" onclick="resolveSuggestion(${s.rowIndex}, 'rejected')">Reject</button>
        </div>`
      : "";
    const statusBadge = s.status === "pending"
      ? `<span class="badge badge-pending">pending</span>`
      : s.status === "approved"
        ? `<span class="badge badge-approved">approved</span>`
        : `<span class="badge">rejected</span>`;
    const slipLink = s.slip_photo_url ? `<a href="/review/slip?slip=${encodeSlipKey(s.slip_photo_url)}" target="_blank">source slip</a> · ` : "";
    const resolution = s.resolved_at
      ? `<div class="muted" style="font-size:12px; margin-top:6px;">Resolved ${escapeHtml(s.resolved_at.slice(0, 16).replace("T", " "))} by ${escapeHtml(s.resolved_by ?? "?")}${s.resolution_notes ? ` — ${escapeHtml(s.resolution_notes)}` : ""}</div>`
      : "";
    return `<div class="suggestion-item">
      <div class="suggestion-header">
        <div>
          <strong>${escapeHtml(s.supplier || "general")}</strong> ${statusBadge}
          <div class="muted" style="font-size:12px;">${escapeHtml(when)} · ${escapeHtml(s.submitted_by || "unknown")} · ${slipLink}row ${s.rowIndex}</div>
        </div>
        ${actions}
      </div>
      <div class="suggestion-body">${escapeHtml(s.suggestion_text)}</div>
      ${resolution}
    </div>`;
  };

  const pendingHtml = pending.length === 0
    ? `<p class="muted" style="padding:24px; text-align:center;">No pending suggestions. Reviewers can submit one from a slip detail page.</p>`
    : pending.map(renderRow).join("");
  const resolvedHtml = resolved.length === 0
    ? `<p class="muted" style="padding:24px; text-align:center;">No resolved suggestions yet.</p>`
    : resolved.slice(0, 40).map(renderRow).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>RVFB Prompt Suggestions</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${STYLE}</style>
</head><body><div class="container">
<header class="page">
  <div>
    <h1>Prompt Suggestions</h1>
    <div class="meta">${suggestions.length} total · ${pending.length} pending · ${escapeHtml(generated)} PT · ${currentEmail ? `signed in as ${escapeHtml(currentEmail)}` : "anonymous"}${isAdmin ? " · admin" : ""}</div>
  </div>
  <div class="tabs">
    <a class="btn" href="/review?tab=queue">Review Queue</a>
    <a class="btn" href="/review?tab=history">All Slips</a>
    <a class="btn active" href="/review?tab=suggestions">Prompt Suggestions${pendingCount > 0 ? ` <span class="badge badge-pending" style="margin-left:6px;">${pendingCount}</span>` : ""}</a>
    <a class="btn" href="/dashboard?view=daily&range=1w">← Dashboard</a>
  </div>
</header>

<h2 class="section-title section-title-warn">
  Pending
  <span class="section-count">${pending.length}</span>
  <span class="section-sub muted">awaiting Chris's review</span>
</h2>
<div class="card" style="padding:0;">${pendingHtml}</div>

<h2 class="section-title">
  Resolved (recent)
  <span class="section-count">${Math.min(resolved.length, 40)}</span>
</h2>
<div class="card" style="padding:0;">${resolvedHtml}</div>

<div class="toast" id="toast"></div>
<footer>Suggestions live in the "Prompt Suggestions" tab. Approvals here don't touch the prompt files — Chris still lands the code change manually.</footer>
</div>
<script>
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2000);
}
async function resolveSuggestion(rowIndex, status) {
  const notes = prompt(status === 'approved'
    ? 'Optional note (e.g. commit sha once applied):'
    : 'Optional note (why rejected):');
  if (notes === null) return;
  try {
    const res = await fetch('/api/review/suggest/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ row_index: rowIndex, status, notes })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Marked ' + status);
    setTimeout(() => { window.location.reload(); }, 600);
  } catch (e) {
    showToast('Failed: ' + e.message, true);
  }
}
</script>
</body></html>`;
}

const EDITABLE_PER_SLIP = ["supplier", "document_type", "invoice_date", "delivery_date", "invoice_or_order_number", "destination_org", "donor_org", "is_donation"];
const EDITABLE_PER_ROW = [
  "item_code_raw",
  "item_name_raw",
  "item_name_normalized",
  "quantity_ordered",
  "quantity",
  "quantity_raw",
  "unit",
  "pack_size_raw",
  "approx_weight",
  "category",
  "unit_cost",
  "line_total",
  "confidence",
  "is_fee",
  "notes"
];

const CATEGORY_OPTIONS = ["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"];
const UNIT_OPTIONS = ["case", "ct", "lb", "oz", "ea", "bushel", "other"];
const DOC_TYPE_OPTIONS = ["invoice", "manifest", "warehouse_posted_shipment", "dock_photo", "unknown"];

function selectInput(name: string, value: string | null, rowIndex: number, options: string[]): string {
  const opts = options.map((o) => `<option value="${escapeHtml(o)}"${value === o ? " selected" : ""}>${escapeHtml(o)}</option>`).join("");
  return `<select data-row="${rowIndex}" data-field="${escapeHtml(name)}" onchange="markEdit(this)">
    <option value=""${!value ? " selected" : ""}>—</option>
    ${opts}
  </select>`;
}

function textInput(name: string, value: string | null, rowIndex: number, type: "text" | "number" = "text"): string {
  const v = value == null ? "" : value;
  return `<input type="${type}" value="${escapeHtml(String(v))}" data-row="${rowIndex}" data-field="${escapeHtml(name)}" oninput="markEdit(this)">`;
}

function boolInput(name: string, value: string | null, rowIndex: number): string {
  const truthy = value && /^(true|1|yes)$/i.test(value);
  return `<select data-row="${rowIndex}" data-field="${escapeHtml(name)}" onchange="markEdit(this)">
    <option value=""${!value ? " selected" : ""}>—</option>
    <option value="true"${truthy ? " selected" : ""}>true</option>
    <option value="false"${value && !truthy ? " selected" : ""}>false</option>
  </select>`;
}

export function buildSlipDetailHtml(params: {
  slip: SlipSummary;
  rows: DeliverySheetRow[];
  token: string;
  supplierPrompt: string | null;
  systemPrompt: string | null;
}): string {
  const { slip, rows, supplierPrompt, systemPrompt } = params;
  const slipMetaRowIndex = rows[0]?.rowIndex ?? 0;

  const slipMeta = `<div class="slip-meta">
    <h3 style="margin-top:0;">Slip-level fields</h3>
    <dl>
      <dt>supplier</dt><dd>${textInput("supplier", slip.supplier, slipMetaRowIndex)}</dd>
      <dt>document_type</dt><dd>${selectInput("document_type", slip.document_type, slipMetaRowIndex, DOC_TYPE_OPTIONS)}</dd>
      <dt>invoice_date</dt><dd>${textInput("invoice_date", slip.invoice_date, slipMetaRowIndex)}</dd>
      <dt>delivery_date</dt><dd>${textInput("delivery_date", slip.delivery_date, slipMetaRowIndex)}</dd>
      <dt>invoice_or_order_number</dt><dd>${textInput("invoice_or_order_number", slip.invoice_or_order_number, slipMetaRowIndex)}</dd>
      <dt>destination_org</dt><dd>${textInput("destination_org", slip.destination_org, slipMetaRowIndex)}</dd>
      <dt>donor_org</dt><dd>${textInput("donor_org", slip.donor_org, slipMetaRowIndex)}</dd>
      <dt>is_donation</dt><dd>${boolInput("is_donation", slip.is_donation, slipMetaRowIndex)}</dd>
    </dl>
    <p class="muted" style="margin-top:12px; font-size:12px;">Editing a slip-level field updates every row of this slip.</p>
  </div>`;

  const lineRows = rows.map((r) => {
    const isFee = /^(true|1|yes)$/i.test(r.is_fee ?? "");
    const isBlank = !isFee
      && (r.quantity == null || r.quantity === "")
      && (r.approx_weight == null || r.approx_weight === "");
    const cls = [isFee ? "fee-row" : "", isBlank ? "row-blank" : ""].filter(Boolean).join(" ");
    return `<tr class="${cls}">
      <td>${textInput("item_code_raw", r.item_code_raw, r.rowIndex)}</td>
      <td>${textInput("item_name_raw", r.item_name_raw, r.rowIndex)}</td>
      <td>${textInput("item_name_normalized", r.item_name_normalized, r.rowIndex)}</td>
      <td>${textInput("quantity_ordered", r.quantity_ordered, r.rowIndex, "number")}</td>
      <td>${textInput("quantity", r.quantity, r.rowIndex, "number")}</td>
      <td>${textInput("quantity_raw", r.quantity_raw, r.rowIndex)}</td>
      <td>${textInput("pack_size_raw", r.pack_size_raw, r.rowIndex)}</td>
      <td>${selectInput("unit", r.unit, r.rowIndex, UNIT_OPTIONS)}</td>
      <td>${selectInput("category", r.category, r.rowIndex, CATEGORY_OPTIONS)}</td>
      <td>${textInput("approx_weight", r.approx_weight, r.rowIndex, "number")}</td>
      <td>${textInput("unit_cost", r.unit_cost, r.rowIndex, "number")}</td>
      <td>${textInput("line_total", r.line_total, r.rowIndex, "number")}</td>
      <td>${boolInput("is_fee", r.is_fee, r.rowIndex)}</td>
      <td>${textInput("confidence", r.confidence, r.rowIndex, "number")}</td>
      <td>${textInput("notes", r.notes, r.rowIndex)}</td>
    </tr>`;
  }).join("");

  const slipKeyEnc = encodeSlipKey(slip.slipKey);
  const proxyUrl = `/review/photo?slip=${slipKeyEnc}`;
  const isPdf = (slip.photo_url ?? "").toLowerCase().includes(".pdf");
  const photoBlock = slip.photo_url
    ? `${isPdf
        ? `<iframe src="${escapeHtml(proxyUrl)}" title="slip photo"></iframe>`
        : `<img src="${escapeHtml(proxyUrl)}" alt="slip photo" onerror="this.style.display='none'">`}
       <p class="muted" style="font-size:12px; margin-top:8px;">
         Proxied through the bot using the Slack token.
         <a href="${escapeHtml(proxyUrl)}" target="_blank" rel="noopener">Open in new tab</a>
         · <a href="${escapeHtml(slip.photo_url)}" target="_blank" rel="noopener">Slack source</a>
       </p>`
    : `<p class="muted">No photo on this slip.</p>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>RVFB Review · ${escapeHtml(slip.supplier)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${STYLE}</style>
</head><body><div class="container">
<header class="page">
  <div>
    <h1>${escapeHtml(slip.supplier)}${slip.invoice_or_order_number ? ` <span class="muted">#${escapeHtml(slip.invoice_or_order_number)}</span>` : ""}</h1>
    <div class="meta">${escapeHtml(slip.delivery_date ?? slip.created_at.slice(0, 10))} · ${slip.rowCount} row${slip.rowCount === 1 ? "" : "s"} · ${statusBadge(slip)}</div>
  </div>
  <div class="tabs">
    <a class="btn" href="/review?tab=queue">← Back to Queue</a>
    <button class="btn btn-primary" onclick="approveSlip()">${slip.approved ? "Re-approve" : "Approve slip"}</button>
  </div>
</header>

<div class="layout-detail">
  <div>
    ${slipMeta}
    <div class="card line-items-card">
      <h3 style="margin-top:0;">Line items</h3>
      <p class="muted" style="font-size:12px; margin:0 0 12px;">Scroll right to access source / cost / notes columns.</p>
      <table class="line-items">
        <colgroup>
          <col class="col-code">
          <col class="col-raw">
          <col class="col-normalized">
          <col class="col-qty-ord">
          <col class="col-qty">
          <col class="col-qty-raw">
          <col class="col-pack">
          <col class="col-unit">
          <col class="col-category">
          <col class="col-weight">
          <col class="col-cost">
          <col class="col-total">
          <col class="col-fee">
          <col class="col-conf">
          <col class="col-notes">
        </colgroup>
        <thead><tr>
          <th>Code</th><th>Raw name</th><th>Normalized</th>
          <th>Qty ord</th><th>Qty</th><th>Qty raw</th>
          <th>Pack</th><th>Unit</th><th>Category</th>
          <th>Weight (lb)</th><th>Unit cost</th><th>Line total</th>
          <th>Fee?</th><th>Conf</th><th>Notes</th>
        </tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
    </div>
  </div>
  <div class="photo-pane card">
    <h3 style="margin-top:0;">Photo</h3>
    ${photoBlock}

    <hr style="margin:20px 0;">
    <h3 style="margin-top:0;">Suggest a prompt improvement</h3>
    <p class="muted" style="font-size:12px; margin:0 0 8px;">See a pattern the extractor keeps missing on this supplier? Type it here — Chris reviews before any prompt change lands.</p>
    <div>
      <label style="display:block; font-size:12px; margin-bottom:4px;">Supplier</label>
      <input type="text" id="suggest-supplier" value="${escapeHtml(slip.supplier ?? "")}" style="width:100%; margin-bottom:8px;" oninput="loadPromptForSupplier(this.value)">
      <label style="display:block; font-size:12px; margin-bottom:4px;">Suggestion</label>
      <textarea id="suggest-text" rows="4" style="width:100%; margin-bottom:8px;" placeholder="e.g. On Caruso slips, keep leading zeros on the item code column (5-digit SKUs)."></textarea>
      <button class="btn btn-primary" onclick="submitSuggestion()">Send to Chris</button>
    </div>

    <details style="margin-top:16px;" open>
      <summary style="cursor:pointer; font-weight:600;">Current supplier prompt <span class="muted" style="font-weight:400; font-size:12px;">(for reference)</span></summary>
      <pre id="supplier-prompt" class="prompt-view">${escapeHtml(supplierPrompt ?? "(no supplier-specific prompt found)")}</pre>
    </details>
    <details style="margin-top:8px;">
      <summary style="cursor:pointer; font-weight:600;">Shared invoice system prompt <span class="muted" style="font-weight:400; font-size:12px;">(applies to every supplier)</span></summary>
      <pre class="prompt-view">${escapeHtml(systemPrompt ?? "(system prompt not loaded)")}</pre>
    </details>
  </div>
</div>

<div class="toast" id="toast"></div>

<footer>Edits write directly to the Inbound Delivery Log and append to Corrections Log. Editing any field re-opens the slip for re-approval.</footer>
</div>
<script>
const SLIP_KEY_B64 = ${JSON.stringify(slipKeyEnc)};

function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2000);
}

function markEdit(el) {
  el.classList.add('dirty');
  const original = el.dataset.original ?? el.defaultValue ?? '';
  if (el.value === original) {
    el.classList.remove('dirty');
    return;
  }
  // Un-dim the containing skeleton row on first edit.
  const tr = el.closest('tr');
  if (tr && tr.classList.contains('row-blank')) tr.classList.add('row-touched');
  // debounce save per element
  clearTimeout(el._t);
  el._t = setTimeout(() => saveEdit(el), 600);
}

async function saveEdit(el) {
  const row_index = parseInt(el.dataset.row, 10);
  const field = el.dataset.field;
  const new_value = el.value;
  try {
    const res = await fetch('/api/review/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slip: SLIP_KEY_B64, row_index, field, new_value })
    });
    if (!res.ok) throw new Error(await res.text());
    el.classList.remove('dirty');
    el.dataset.original = new_value;
    showToast('Saved: ' + field);
  } catch (e) {
    showToast('Save failed: ' + e.message, true);
  }
}

async function approveSlip() {
  try {
    const res = await fetch('/api/review/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slip: SLIP_KEY_B64 })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Slip approved');
    setTimeout(() => { window.location.href = '/review?tab=queue'; }, 800);
  } catch (e) {
    showToast('Approve failed: ' + e.message, true);
  }
}

let _promptFetchToken = 0;
async function loadPromptForSupplier(supplier) {
  const target = document.getElementById('supplier-prompt');
  if (!target) return;
  const t = ++_promptFetchToken;
  try {
    const res = await fetch('/api/prompts?supplier=' + encodeURIComponent(supplier.trim()));
    const text = await res.text();
    if (t !== _promptFetchToken) return; // superseded by newer keystroke
    target.textContent = res.ok ? text : '(no prompt for "' + supplier + '")';
  } catch (e) {
    if (t !== _promptFetchToken) return;
    target.textContent = '(failed to load prompt: ' + e.message + ')';
  }
}

async function submitSuggestion() {
  const supplier = document.getElementById('suggest-supplier').value.trim();
  const text = document.getElementById('suggest-text').value.trim();
  if (!text) { showToast('Suggestion text is required', true); return; }
  try {
    const res = await fetch('/api/review/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slip: SLIP_KEY_B64, supplier, suggestion_text: text })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Sent to Chris — thanks!');
    document.getElementById('suggest-text').value = '';
  } catch (e) {
    showToast('Send failed: ' + e.message, true);
  }
}

// snapshot originals
document.querySelectorAll('input,select,textarea').forEach((el) => {
  el.dataset.original = el.value;
});
</script>
</body></html>`;
}

export { EDITABLE_PER_SLIP, EDITABLE_PER_ROW };
