import type { DeliverySheetRow } from "./types.js";
import type { SlipSummary } from "./sheets.js";

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
  if (slip.approved) return `<span class="badge badge-approved">approved</span>`;
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
  :root {
    --bg:#f7f7f5; --card:#fff; --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb;
    --ok:#047857; --ok-bg:#ecfdf5; --warn:#b45309; --warn-bg:#fef3c7;
    --pending:#b45309; --pending-bg:#fef3c7; --approved:#047857; --approved-bg:#ecfdf5;
    --danger:#b91c1c;
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 24px; font-family:-apple-system,BlinkMacSystemFont,Inter,system-ui,sans-serif;
         background:var(--bg); color:var(--ink); line-height:1.5; font-size:14px; }
  .container { max-width:1400px; margin:0 auto; }
  header { display:flex; justify-content:space-between; align-items:flex-end;
           border-bottom:2px solid var(--ink); padding-bottom:16px; margin-bottom:24px;
           flex-wrap:wrap; gap:16px; }
  header h1 { margin:0; font-size:24px; font-weight:700; letter-spacing:-0.02em; }
  header .meta { color:var(--muted); font-size:13px; }
  .tabs { display:flex; gap:6px; }
  .btn { display:inline-block; padding:6px 14px; border:1px solid var(--line); background:var(--card);
         color:var(--ink); border-radius:999px; font-size:13px; font-weight:600;
         text-decoration:none; cursor:pointer; }
  .btn.active { background:var(--ink); color:#fff; border-color:var(--ink); }
  .btn:hover:not(.active) { background:#f3f4f6; }
  .btn-danger { color:var(--danger); border-color:var(--danger); }
  .btn-danger:hover { background:#fef2f2; }
  .btn-primary { background:var(--ok); color:#fff; border-color:var(--ok); }
  .btn-primary:hover { background:#065f46; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:16px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { padding:10px 12px; border-bottom:1px solid var(--line); font-variant-numeric:tabular-nums; vertical-align:top; }
  thead th { text-align:left; background:#f3f4f6; border-bottom:2px solid var(--line);
             font-weight:600; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; }
  tr:hover td { background:#fafafa; }
  .muted { color:var(--muted); }
  .badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px;
           font-weight:700; text-transform:uppercase; letter-spacing:0.04em; }
  .badge-pending { background:var(--pending-bg); color:var(--pending); }
  .badge-approved { background:var(--approved-bg); color:var(--approved); }
  .conf { display:inline-block; padding:1px 6px; border-radius:4px; font-weight:600; font-variant-numeric:tabular-nums; }
  .conf-low { background:#fef2f2; color:var(--danger); }
  .conf-ok { background:var(--ok-bg); color:var(--ok); }
  a.slip-link { color:var(--ink); text-decoration:none; font-weight:600; }
  a.slip-link:hover { text-decoration:underline; }
  .layout-detail { display:grid; grid-template-columns:minmax(0, 1.6fr) minmax(320px, 1fr); gap:16px; }
  @media (max-width:1100px) { .layout-detail { grid-template-columns:1fr; } }
  .photo-pane img, .photo-pane iframe { width:100%; height:auto; border-radius:8px; border:1px solid var(--line); display:block; }
  .photo-pane iframe { height:80vh; }
  .photo-pane a { color:var(--ok); font-size:13px; word-break:break-all; }
  .slip-meta { background:var(--card); border:1px solid var(--line); border-radius:12px;
               padding:16px; margin-bottom:16px; font-size:13px; }
  .slip-meta dl { display:grid; grid-template-columns:140px 1fr; gap:8px 12px; margin:0; }
  .slip-meta dt { color:var(--muted); font-weight:600; }
  .slip-meta dd { margin:0; font-variant-numeric:tabular-nums; }
  input[type="text"], input[type="number"], select, textarea {
    width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px;
    background:#fff; font-family:inherit; font-size:13px; font-variant-numeric:tabular-nums;
  }
  input.dirty, select.dirty { background:#fef3c7; }
  .row-edit { display:flex; gap:6px; align-items:center; }
  .fee-row { background:#fefce8; }

  /* Editable line-items table: give every cell room to breathe + horizontal scroll if needed */
  .line-items-card { overflow-x:auto; }
  table.line-items { min-width: 880px; }
  table.line-items th, table.line-items td { padding:8px 8px; }
  table.line-items col.col-raw      { width: 180px; }
  table.line-items col.col-normalized { width: 200px; }
  table.line-items col.col-qty      { width: 80px; }
  table.line-items col.col-unit     { width: 90px; }
  table.line-items col.col-category { width: 130px; }
  table.line-items col.col-weight   { width: 90px; }
  table.line-items col.col-fee      { width: 80px; }
  table.line-items col.col-conf     { width: 60px; }
  table.line-items input, table.line-items select { min-width: 0; }
  footer { margin-top:32px; padding-top:16px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; text-align:center; }
  .toast { position:fixed; bottom:20px; right:20px; padding:12px 18px; border-radius:8px;
           background:var(--ink); color:#fff; font-size:13px; font-weight:600; z-index:1000;
           opacity:0; transition:opacity 0.2s; pointer-events:none; }
  .toast.show { opacity:1; }
  .toast.error { background:var(--danger); }
`;

export function buildReviewListHtml(params: {
  slips: SlipSummary[];
  pendingOnly: boolean;
  threshold: number;
  token: string;
  generatedAt: Date;
}): string {
  const { slips, pendingOnly, threshold, token, generatedAt } = params;
  const t = encodeURIComponent(token);

  const rows = slips.map((s) => {
    const enc = encodeSlipKey(s.slipKey);
    const date = s.delivery_date || `<span class="muted">${escapeHtml(s.created_at.slice(0, 10))}</span>`;
    const invoice = s.invoice_or_order_number ? escapeHtml(s.invoice_or_order_number) : `<span class="muted">—</span>`;
    return `<tr>
      <td>${statusBadge(s)}</td>
      <td>${date}</td>
      <td>${donorOrSupplier(s)}</td>
      <td>${invoice}</td>
      <td class="num">${s.rowCount}</td>
      <td>${confidenceBadge(s.minConfidence, threshold)}</td>
      <td><a class="slip-link" href="/review/slip?slip=${enc}&token=${t}">Open ›</a></td>
    </tr>`;
  }).join("");

  const queueCls = pendingOnly ? "btn active" : "btn";
  const historyCls = pendingOnly ? "btn" : "btn active";
  const generated = generatedAt.toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>RVFB Review</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${STYLE}</style>
</head><body><div class="container">
<header>
  <div>
    <h1>RVFB Slip Review</h1>
    <div class="meta">${slips.length} slip${slips.length === 1 ? "" : "s"} · confidence threshold ${Math.round(threshold * 100)}% · ${escapeHtml(generated)} PT</div>
  </div>
  <div class="tabs">
    <a class="${queueCls}" href="/review?tab=queue&token=${t}">Review Queue</a>
    <a class="${historyCls}" href="/review?tab=history&token=${t}">All Slips</a>
    <a class="btn" href="/dashboard?view=daily&range=1w&token=${t}">← Dashboard</a>
  </div>
</header>
<div class="card">
${slips.length === 0
  ? `<p class="muted" style="padding:24px; text-align:center;">No slips ${pendingOnly ? "need review" : "found"}.</p>`
  : `<table>
      <thead><tr>
        <th>Status</th><th>Delivery date</th><th>Donor / Supplier</th><th>Invoice #</th>
        <th class="num">Rows</th><th>Min confidence</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`}
</div>
<footer>RVFB Inventory · Slip Review · Edit history in Corrections Log tab</footer>
</div></body></html>`;
}

const EDITABLE_PER_SLIP = ["supplier", "delivery_date", "invoice_or_order_number", "donor_org", "is_donation"];
const EDITABLE_PER_ROW = ["item_name_normalized", "quantity", "unit", "category", "approx_weight", "is_fee"];

const CATEGORY_OPTIONS = ["produce", "meat_protein", "dairy", "shelf_stable", "frozen", "non_food", "unknown"];
const UNIT_OPTIONS = ["case", "ct", "lb", "oz", "ea", "bushel", "other"];

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
}): string {
  const { slip, rows, token } = params;
  const t = encodeURIComponent(token);
  const slipMetaRowIndex = rows[0]?.rowIndex ?? 0;

  const slipMeta = `<div class="slip-meta">
    <h3 style="margin-top:0;">Slip-level fields</h3>
    <dl>
      <dt>supplier</dt><dd>${textInput("supplier", slip.supplier, slipMetaRowIndex)}</dd>
      <dt>delivery_date</dt><dd>${textInput("delivery_date", slip.delivery_date, slipMetaRowIndex)}</dd>
      <dt>invoice_or_order_number</dt><dd>${textInput("invoice_or_order_number", slip.invoice_or_order_number, slipMetaRowIndex)}</dd>
      <dt>donor_org</dt><dd>${textInput("donor_org", slip.donor_org, slipMetaRowIndex)}</dd>
      <dt>is_donation</dt><dd>${boolInput("is_donation", slip.is_donation, slipMetaRowIndex)}</dd>
    </dl>
    <p class="muted" style="margin-top:12px; font-size:12px;">Editing a slip-level field updates every row of this slip.</p>
  </div>`;

  const lineRows = rows.map((r) => {
    const isFee = /^(true|1|yes)$/i.test(r.is_fee ?? "");
    const conf = r.confidence ? parseFloat(r.confidence) : NaN;
    const confCell = Number.isFinite(conf)
      ? `<span class="conf conf-${conf < 0.85 ? "low" : "ok"}">${Math.round(conf * 100)}%</span>`
      : `<span class="muted">—</span>`;
    return `<tr class="${isFee ? "fee-row" : ""}">
      <td>${escapeHtml(r.item_name_raw ?? "")}<div class="muted" style="font-size:11px;">${escapeHtml(r.pack_size_raw ?? "")}</div></td>
      <td>${textInput("item_name_normalized", r.item_name_normalized, r.rowIndex)}</td>
      <td>${textInput("quantity", r.quantity, r.rowIndex, "number")}</td>
      <td>${selectInput("unit", r.unit, r.rowIndex, UNIT_OPTIONS)}</td>
      <td>${selectInput("category", r.category, r.rowIndex, CATEGORY_OPTIONS)}</td>
      <td>${textInput("approx_weight", r.approx_weight, r.rowIndex, "number")}</td>
      <td>${boolInput("is_fee", r.is_fee, r.rowIndex)}</td>
      <td>${confCell}</td>
    </tr>`;
  }).join("");

  const slipKeyEnc = encodeSlipKey(slip.slipKey);
  const proxyUrl = `/review/photo?slip=${slipKeyEnc}&token=${t}`;
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
<style>${STYLE}</style>
</head><body><div class="container">
<header>
  <div>
    <h1>${escapeHtml(slip.supplier)}${slip.invoice_or_order_number ? ` <span class="muted">#${escapeHtml(slip.invoice_or_order_number)}</span>` : ""}</h1>
    <div class="meta">${escapeHtml(slip.delivery_date ?? slip.created_at.slice(0, 10))} · ${slip.rowCount} row${slip.rowCount === 1 ? "" : "s"} · ${statusBadge(slip)}</div>
  </div>
  <div class="tabs">
    <a class="btn" href="/review?tab=queue&token=${t}">← Back to Queue</a>
    <button class="btn btn-primary" onclick="approveSlip()">${slip.approved ? "Re-approve" : "Approve slip"}</button>
  </div>
</header>

<div class="layout-detail">
  <div>
    ${slipMeta}
    <div class="card line-items-card">
      <h3 style="margin-top:0;">Line items</h3>
      <table class="line-items">
        <colgroup>
          <col class="col-raw">
          <col class="col-normalized">
          <col class="col-qty">
          <col class="col-unit">
          <col class="col-category">
          <col class="col-weight">
          <col class="col-fee">
          <col class="col-conf">
        </colgroup>
        <thead><tr>
          <th>Raw name</th><th>Normalized</th><th>Qty</th><th>Unit</th><th>Category</th><th>Weight (lb)</th><th>Fee?</th><th>Conf</th>
        </tr></thead>
        <tbody>${lineRows}</tbody>
      </table>
    </div>
  </div>
  <div class="photo-pane card">
    <h3 style="margin-top:0;">Photo</h3>
    ${photoBlock}
  </div>
</div>

<div class="toast" id="toast"></div>

<footer>Edits write directly to the Inbound Delivery Log and append to Corrections Log. Editing any field re-opens the slip for re-approval.</footer>
</div>
<script>
const SLIP_KEY_B64 = ${JSON.stringify(slipKeyEnc)};
const TOKEN = ${JSON.stringify(token)};

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
  // debounce save per element
  clearTimeout(el._t);
  el._t = setTimeout(() => saveEdit(el), 600);
}

async function saveEdit(el) {
  const row_index = parseInt(el.dataset.row, 10);
  const field = el.dataset.field;
  const new_value = el.value;
  try {
    const res = await fetch('/api/review/edit?token=' + encodeURIComponent(TOKEN), {
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
    const res = await fetch('/api/review/approve?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slip: SLIP_KEY_B64 })
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Slip approved');
    setTimeout(() => { window.location.href = '/review?tab=queue&token=' + encodeURIComponent(TOKEN); }, 800);
  } catch (e) {
    showToast('Approve failed: ' + e.message, true);
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
