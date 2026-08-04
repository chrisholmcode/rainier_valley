// Crate labels — printable sticker/label pages for physical crate tagging,
// tied to the outbound-tracking crate registry.
//
// Flow:
//   GET  /labels               — form: pick item + date + qty + source + size (prefilled by review UI)
//   POST /labels/print         — mint N crate rows, render N labels with unique QR codes
//   GET  /crate/<uuid>         — mobile scan page (in index.ts)
//   POST /api/crate/<uuid>/consume — write outbound row, mark crate empty/partial
//
// A "crate" is the unit that closes the inbound→outbound loop. Every printed
// label maps 1:1 to a row in the Crates sheet. The QR encodes the scan URL.

import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { FONT_HEAD_LINKS, SHARED_CSS } from "./ui-styles.js";
import { env } from "./config.js";
import { appendCrateRows, type CrateMintInput } from "./sheets.js";

// Canonical crate categories, seeded from Edmonds shelf labels. Free-text
// override via the "Custom" option in the form.
export const CRATE_ITEMS: string[] = [
  "Baked Beans / Pork & Beans",
  "Misc. Beans / Chili Beans",
  "Refried Beans",
  "Green Beans",
  "Corn",
  "Misc. Mixed Vegs",
  "Chili",
  "Canned Pasta",
  "Hot Cereal",
  "Coffee",
  "Hot Chocolate / Cider",
  "Tea",
  "Chicken",
  "Tuna",
  "Peanut Butter",
  "Rice",
  "Pasta",
  "Cereal"
];

export const SOURCE_OPTIONS: readonly string[] = [
  "",
  "TEFAP",
  "Donation",
  "Purchased",
  "Grocery Rescue",
  "Food Drive"
] as const;

export const UNIT_OPTIONS: readonly string[] = [
  "",
  "cans",
  "boxes",
  "bags",
  "cases",
  "lbs",
  "each"
] as const;

export const LABEL_SIZES: Record<string, { widthIn: number; heightIn: number; label: string }> = {
  "4x2":     { widthIn: 4,    heightIn: 2,    label: '4" × 2" (Brother DK-1202 shipping)' },
  "3x2":     { widthIn: 3,    heightIn: 2,    label: '3" × 2" (index card)' },
  "2.25x1.25": { widthIn: 2.25, heightIn: 1.25, label: '2.25" × 1.25" (small thermal)' }
};

const LABELS_CSS = `
.labels-shell { max-width: 760px; margin: 0 auto; padding: 32px 24px 64px; }
.labels-header { margin-bottom: 24px; }
.labels-header h1 { font-size: 32px; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 700; }
.labels-header p { margin: 0; color: var(--muted); font-size: 14px; }
form.labels { display: flex; flex-direction: column; gap: 20px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-size: 13px; font-weight: 600; color: var(--ink); }
.field .hint { font-size: 12px; color: var(--muted); }
.field input[type=text],
.field input[type=date],
.field input[type=number],
.field select {
  width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
  font-size: 15px; font-family: inherit; background: #fff; color: var(--ink);
}
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
.actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 8px; }
.context-banner {
  background: var(--primary-bg); border-left: 3px solid var(--primary);
  padding: 12px 16px; border-radius: 8px; font-size: 13px; color: var(--ink);
  margin-bottom: 8px;
}
.context-banner strong { color: var(--primary); }
@media (max-width: 640px) {
  .two-col, .three-col { grid-template-columns: 1fr; }
}
`;

export interface LabelsFormOptions {
  presetItem?: string | null;
  presetDate?: string | null;
  presetSource?: string | null;
  presetQtyPerCrate?: number | null;
  presetUnit?: string | null;
  presetWeightLb?: number | null;
  slipKey?: string | null;      // photo_url from review UI
  intakeRowIndex?: number | null;
  slipLabel?: string | null;    // e.g. "Grand Central · 7-22-26"
}

export function buildLabelsFormHtml(opts: LabelsFormOptions = {}): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const presetItem = (opts.presetItem ?? "").trim();
  const presetDate = (opts.presetDate ?? today).trim();
  const presetSource = (opts.presetSource ?? "").trim();
  const presetUnit = (opts.presetUnit ?? "").trim();
  const presetQty = opts.presetQtyPerCrate != null ? String(opts.presetQtyPerCrate) : "";
  const presetWeight = opts.presetWeightLb != null ? String(opts.presetWeightLb) : "";

  const itemInList = presetItem && CRATE_ITEMS.some((i) => i.toLowerCase() === presetItem.toLowerCase());
  const customVisible = presetItem && !itemInList;

  const itemOptions = ["", ...CRATE_ITEMS]
    .map((v) => {
      const selected = v.toLowerCase() === presetItem.toLowerCase() ? " selected" : "";
      const label = v === "" ? "— Pick a category —" : v;
      return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const sourceOptions = SOURCE_OPTIONS
    .map((v) => {
      const selected = v === presetSource ? " selected" : "";
      const label = v === "" ? "(no source tag)" : v;
      return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const unitOptions = UNIT_OPTIONS
    .map((v) => {
      const selected = v === presetUnit ? " selected" : "";
      const label = v === "" ? "—" : v;
      return `<option value="${escapeHtml(v)}"${selected}>${escapeHtml(label)}</option>`;
    })
    .join("");

  const sizeOptions = Object.entries(LABEL_SIZES)
    .map(([key, s]) => `<option value="${escapeHtml(key)}">${escapeHtml(s.label)}</option>`)
    .join("");

  const contextBanner = opts.slipLabel
    ? `<div class="context-banner">Minting crates for <strong>${escapeHtml(opts.slipLabel)}</strong>. Scanning any of these labels later will write to the outbound log with a link back to this delivery.</div>`
    : `<div class="context-banner">Freeform crates — no delivery tie-in. Scans will still record outbound but won't link back to an intake row.</div>`;

  const slipKeyInput = opts.slipKey
    ? `<input type="hidden" name="slip_key" value="${escapeHtml(opts.slipKey)}">`
    : "";
  const rowIndexInput = opts.intakeRowIndex != null
    ? `<input type="hidden" name="intake_row_index" value="${escapeHtml(String(opts.intakeRowIndex))}">`
    : "";

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Crate labels — ${escapeHtml(env.TENANT_NAME)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${SHARED_CSS}${LABELS_CSS}</style>
</head><body>
<div class="labels-shell">
  <div class="labels-header">
    <h1>Print crate labels</h1>
    <p>Each label carries a unique QR — scanning it later marks the crate consumed and writes an outbound row.</p>
  </div>
  ${contextBanner}
  <form class="labels" method="POST" action="/labels/print" target="_blank">
    ${slipKeyInput}
    ${rowIndexInput}
    <div class="field">
      <label for="item">Item</label>
      <select id="item" name="item" onchange="toggleCustom(this)">
        ${itemOptions}
        <option value="__custom__"${customVisible ? " selected" : ""}>Custom (type below)</option>
      </select>
    </div>
    <div class="field" id="custom-wrap" style="display:${customVisible ? "flex" : "none"};">
      <label for="custom_item">Custom item name</label>
      <input type="text" id="custom_item" name="custom_item" value="${escapeHtml(customVisible ? presetItem : "")}" placeholder="e.g. Applesauce">
    </div>
    <div class="two-col">
      <div class="field">
        <label for="date">Date</label>
        <input type="date" id="date" name="date" value="${escapeHtml(presetDate)}" required>
        <span class="hint">Prints as M-D-YY on the label.</span>
      </div>
      <div class="field">
        <label for="qty">Number of crates</label>
        <input type="number" id="qty" name="qty" min="1" max="100" value="1" required>
        <span class="hint">One label per crate.</span>
      </div>
    </div>
    <div class="three-col">
      <div class="field">
        <label for="qty_per_crate">Units per crate</label>
        <input type="number" id="qty_per_crate" name="qty_per_crate" min="0" step="0.1" value="${escapeHtml(presetQty)}">
        <span class="hint">e.g. 24 cans</span>
      </div>
      <div class="field">
        <label for="unit">Unit</label>
        <select id="unit" name="unit">${unitOptions}</select>
      </div>
      <div class="field">
        <label for="weight_lb_per_crate">Weight per crate (lb)</label>
        <input type="number" id="weight_lb_per_crate" name="weight_lb_per_crate" min="0" step="0.1" value="${escapeHtml(presetWeight)}">
      </div>
    </div>
    <div class="two-col">
      <div class="field">
        <label for="source">Source tag</label>
        <select id="source" name="source">${sourceOptions}</select>
        <span class="hint">Colored strip at the top (yellow = TEFAP).</span>
      </div>
      <div class="field">
        <label for="size">Label size</label>
        <select id="size" name="size">${sizeOptions}</select>
      </div>
    </div>
    <div class="actions">
      <button type="submit" class="btn btn-primary">Mint + print labels</button>
    </div>
  </form>
</div>
<script>
function toggleCustom(sel) {
  const wrap = document.getElementById('custom-wrap');
  wrap.style.display = sel.value === '__custom__' ? 'flex' : 'none';
}
</script>
</body></html>`;
}

export interface LabelsPrintInput {
  item: string;
  date: string;             // ISO YYYY-MM-DD
  qty: number;              // # of labels/crates
  source: string;
  sizeKey: string;
  qtyPerCrate: number | null;
  unit: string | null;
  weightLbPerCrate: number | null;
  slipKey: string | null;
  intakeRowIndex: number | null;
  printedBy: string;
  baseUrl: string;          // e.g. "https://edmonds.loadslip.com"
}

// Parses the POST form body into a normalized print input. Called by the
// index.ts route handler.
export function parseLabelsPostBody(body: string): Omit<LabelsPrintInput, "printedBy" | "baseUrl"> {
  const params = new URLSearchParams(body);
  const itemSel = (params.get("item") ?? "").trim();
  const customItem = (params.get("custom_item") ?? "").trim();
  const item = itemSel === "__custom__" || itemSel === "" ? customItem : itemSel;
  const date = (params.get("date") ?? "").trim()
    || new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const qtyRaw = parseInt(params.get("qty") ?? "1", 10);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.min(qtyRaw, 100) : 1;
  const source = (params.get("source") ?? "").trim();
  const sizeKey = (params.get("size") ?? "4x2").trim();
  const qpcRaw = (params.get("qty_per_crate") ?? "").trim();
  const qtyPerCrate = qpcRaw ? Number(qpcRaw) : null;
  const unit = (params.get("unit") ?? "").trim() || null;
  const wRaw = (params.get("weight_lb_per_crate") ?? "").trim();
  const weightLbPerCrate = wRaw ? Number(wRaw) : null;
  const slipKey = (params.get("slip_key") ?? "").trim() || null;
  const iriRaw = (params.get("intake_row_index") ?? "").trim();
  const intakeRowIndex = iriRaw && !Number.isNaN(Number(iriRaw)) ? Number(iriRaw) : null;
  return {
    item, date, qty, source, sizeKey,
    qtyPerCrate: qtyPerCrate != null && Number.isFinite(qtyPerCrate) ? qtyPerCrate : null,
    unit,
    weightLbPerCrate: weightLbPerCrate != null && Number.isFinite(weightLbPerCrate) ? weightLbPerCrate : null,
    slipKey,
    intakeRowIndex
  };
}

// Mints N crate rows in the sheet, generates QR codes, and returns the
// printable HTML page. Called from POST /labels/print.
export async function mintAndBuildLabelsPrintHtml(input: LabelsPrintInput): Promise<string> {
  const qty = Math.max(1, Math.min(100, Math.floor(input.qty)));
  const item = input.item.trim() || "(unnamed)";

  const crateIds = Array.from({ length: qty }, () => randomUUID());

  const mintInputs: CrateMintInput[] = crateIds.map((id) => ({
    crate_id: id,
    printed_by: input.printedBy,
    slip_key: input.slipKey,
    intake_row_index: input.intakeRowIndex,
    item_name: item,
    qty_per_crate: input.qtyPerCrate,
    unit: input.unit,
    weight_lb_per_crate: input.weightLbPerCrate,
    source_tag: input.source || null
  }));

  await appendCrateRows(mintInputs);

  const qrs = await Promise.all(
    crateIds.map((id) =>
      QRCode.toDataURL(`${input.baseUrl}/crate/${id}`, {
        errorCorrectionLevel: "H",
        margin: 1,
        width: 300
      })
    )
  );

  return renderLabelsPrintHtml({
    item,
    date: input.date,
    source: input.source,
    sizeKey: input.sizeKey,
    crateIds,
    qrs
  });
}

interface RenderInput {
  item: string;
  date: string;
  source: string;
  sizeKey: string;
  crateIds: string[];
  qrs: string[]; // data URLs
}

function renderLabelsPrintHtml(input: RenderInput): string {
  const size = LABEL_SIZES[input.sizeKey] ?? LABEL_SIZES["4x2"];
  const qty = input.crateIds.length;
  const dateDisplay = formatDateDisplay(input.date);
  const sourceColor = sourceStripColor(input.source);

  const labels = input.crateIds.map((id, i) => {
    const last = i === qty - 1;
    return `<div class="label${last ? " last" : ""}">
      ${input.source ? `<div class="source-strip" style="background:${sourceColor};">${escapeHtml(input.source)}</div>` : ""}
      <div class="body">
        <div class="text">
          <div class="item">${escapeHtml(input.item)}</div>
          <div class="date">${escapeHtml(dateDisplay)}</div>
          <div class="crate-id">${escapeHtml(id.slice(0, 8))}</div>
        </div>
        <img class="qr" src="${input.qrs[i]}" alt="scan">
      </div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Labels — ${escapeHtml(input.item)} ${escapeHtml(dateDisplay)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>
  @page { size: ${size.widthIn}in ${size.heightIn}in; margin: 0; }
  html, body { margin: 0; padding: 0; background: #eef0f4; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  .toolbar {
    position: sticky; top: 0; z-index: 10;
    padding: 12px 16px; background: #fff; border-bottom: 1px solid #e3e8ee;
    display: flex; gap: 12px; justify-content: center; align-items: center;
  }
  .toolbar button {
    padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 600;
    background: #635bff; color: #fff; border: none; cursor: pointer; font-family: inherit;
  }
  .toolbar a { color: #635bff; text-decoration: none; font-size: 14px; }
  .label {
    width: ${size.widthIn}in; height: ${size.heightIn}in;
    margin: 12px auto; background: #fff;
    box-shadow: 0 2px 6px rgba(10,37,64,0.08);
    padding: 0.12in; box-sizing: border-box;
    page-break-after: always;
    position: relative;
    overflow: hidden;
  }
  .label.last { page-break-after: auto; }
  .source-strip {
    position: absolute; top: 0; left: 0; right: 0;
    padding: 0.04in 0; font-size: 0.14in; font-weight: 800;
    letter-spacing: 0.08em; text-transform: uppercase; color: #0a2540;
    text-align: center;
  }
  .body {
    display: flex; flex-direction: row; align-items: center; gap: 0.1in;
    height: 100%;
    padding-top: ${input.source ? "0.24in" : "0"};
    box-sizing: border-box;
  }
  .text {
    flex: 1 1 auto; min-width: 0;
    display: flex; flex-direction: column; justify-content: center; gap: 0.04in;
  }
  .item {
    font-size: ${itemFontSize(input.item, size.widthIn)}in;
    font-weight: 800; letter-spacing: -0.01em; line-height: 1.05;
    overflow-wrap: break-word;
  }
  .date {
    font-size: ${size.heightIn >= 2 ? "0.34" : "0.26"}in;
    font-weight: 700; font-variant-numeric: tabular-nums;
    color: #0a2540;
  }
  .crate-id {
    font-size: 0.09in; color: #697386;
    font-family: 'SFMono-Regular', Menlo, Consolas, monospace;
    letter-spacing: 0.05em;
  }
  .qr {
    flex: 0 0 auto;
    width:  ${qrSizeIn(size.widthIn, size.heightIn)}in;
    height: ${qrSizeIn(size.widthIn, size.heightIn)}in;
    display: block;
  }
  @media print {
    .toolbar { display: none; }
    body { background: #fff; }
    .label { margin: 0; box-shadow: none; }
  }
</style>
</head><body>
<div class="toolbar">
  <button onclick="window.print()">Print</button>
  <a href="javascript:history.back()">← Back to form</a>
  <span style="color:#697386; font-size:13px;">${qty} label${qty === 1 ? "" : "s"} · ${size.widthIn}″ × ${size.heightIn}″ · minted &amp; ready to scan</span>
</div>
${labels}
<script>
  window.addEventListener('load', () => setTimeout(() => window.print(), 250));
</script>
</body></html>`;
}

function qrSizeIn(widthIn: number, heightIn: number): number {
  // Target ~90% of label height, capped so the text side stays legible.
  const byHeight = heightIn - 0.35;
  const cap = widthIn * 0.45;
  return Math.max(0.8, Math.min(byHeight, cap));
}

function formatDateDisplay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${Number(mo)}-${Number(d)}-${y.slice(2)}`;
}

function itemFontSize(item: string, widthIn: number): string {
  const chars = item.length;
  // Text now shares the label with the QR — smaller base than the no-QR version.
  const base = widthIn >= 4 ? 0.38 : widthIn >= 3 ? 0.32 : 0.22;
  if (chars <= 8) return base.toFixed(2);
  if (chars <= 14) return (base * 0.85).toFixed(2);
  if (chars <= 22) return (base * 0.7).toFixed(2);
  return (base * 0.55).toFixed(2);
}

function sourceStripColor(source: string): string {
  switch (source) {
    case "TEFAP":          return "#fde047";
    case "Donation":       return "#bbf7d0";
    case "Purchased":      return "#e0e7ff";
    case "Grocery Rescue": return "#fed7aa";
    case "Food Drive":     return "#fbcfe8";
    default:               return "#e3e8ee";
  }
}

// ── Scan page ───────────────────────────────────────────────────────────────

export interface ScanPageOptions {
  crateId: string;
  itemName: string;
  qtyPerCrate: number | null;
  unit: string | null;
  weightLbPerCrate: number | null;
  sourceTag: string | null;
  createdAt: string;      // ISO
  status: "active" | "empty" | "partial";
  consumedAt: string | null;
  consumedBy: string | null;
  consumedQty: number | null;
  slipLabel: string | null;   // e.g. "Grand Central · 7-22-26"
}

const SCAN_CSS = `
.scan-shell { max-width: 480px; margin: 0 auto; padding: 24px 20px 48px; }
.crate-card {
  background: #fff; border: 1px solid var(--line); border-radius: 16px;
  padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 0 rgba(50,50,93,0.025);
}
.crate-card .item {
  font-size: 32px; font-weight: 800; letter-spacing: -0.02em;
  line-height: 1.1; margin-bottom: 12px;
}
.crate-card .meta {
  display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px;
  font-size: 15px; color: var(--ink-2);
}
.crate-card .meta .k { color: var(--muted); font-size: 13px; }
.status-strip {
  padding: 10px 14px; border-radius: 8px; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.05em; font-size: 13px;
  margin-bottom: 16px; text-align: center;
}
.status-active { background: #e6f6ef; color: #00805f; }
.status-empty { background: #f4f5f8; color: #697386; }
.status-partial { background: #fef3c7; color: #9a6308; }
.action-card { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 20px; }
.btn-empty {
  display: block; width: 100%; padding: 18px; margin-bottom: 12px;
  background: #00805f; color: #fff; border: none; border-radius: 12px;
  font-size: 17px; font-weight: 700; cursor: pointer; font-family: inherit;
}
.btn-empty:hover { background: #006a4d; }
.btn-empty:disabled { background: #cbd5e0; cursor: not-allowed; }
.partial-row {
  display: flex; gap: 10px; align-items: center; margin-top: 16px;
  padding-top: 16px; border-top: 1px solid var(--line);
}
.partial-row input {
  flex: 1; padding: 12px; border: 1px solid var(--line); border-radius: 8px;
  font-size: 16px; font-family: inherit;
}
.partial-row button {
  padding: 12px 16px; border-radius: 8px; background: var(--card);
  border: 1px solid var(--line); font-size: 14px; font-weight: 600; cursor: pointer;
  font-family: inherit; color: var(--ink);
}
.toast {
  position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
  background: var(--ink); color: #fff; padding: 12px 20px; border-radius: 999px;
  font-size: 14px; opacity: 0; transition: opacity 0.2s;
}
.toast.show { opacity: 1; }
.toast.error { background: var(--danger); }
.linkback { text-align: center; margin-top: 20px; font-size: 13px; }
.linkback a { color: var(--primary); text-decoration: none; }
`;

export function buildScanPageHtml(opts: ScanPageOptions): string {
  const isActive = opts.status === "active";
  const statusText = opts.status === "active" ? "Active — on the floor"
    : opts.status === "empty" ? `Emptied ${escapeHtml(formatDateTime(opts.consumedAt))} by ${escapeHtml(opts.consumedBy ?? "")}`
    : `Partial — ${opts.consumedQty ?? 0} out on ${escapeHtml(formatDateTime(opts.consumedAt))}`;

  const qtyLine = opts.qtyPerCrate != null
    ? `${opts.qtyPerCrate}${opts.unit ? " " + opts.unit : ""}`
    : "—";

  const weightLine = opts.weightLbPerCrate != null ? `${opts.weightLbPerCrate} lb` : "—";
  const sourceLine = opts.sourceTag || "—";
  const slipLine = opts.slipLabel || "Freeform crate (no delivery link)";

  const actionCard = isActive ? `
    <div class="action-card">
      <button class="btn-empty" onclick="markEmpty()">✓ Empty crate — all out</button>
      <div class="partial-row">
        <input type="number" id="partial-qty" min="0" step="0.1" placeholder="How many went out?">
        <button onclick="markPartial()">Save partial</button>
      </div>
    </div>` : `
    <div class="action-card" style="text-align:center; color: var(--muted);">
      Crate already recorded. If this was a mistake, edit the Crates tab in the sheet.
    </div>`;

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>${escapeHtml(opts.itemName)} — crate</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${SHARED_CSS}${SCAN_CSS}</style>
</head><body>
<div class="scan-shell">
  <div class="crate-card">
    <div class="item">${escapeHtml(opts.itemName)}</div>
    <div class="meta">
      <div class="k">Contents</div><div>${escapeHtml(qtyLine)}</div>
      <div class="k">Weight</div><div>${escapeHtml(weightLine)}</div>
      <div class="k">Source</div><div>${escapeHtml(sourceLine)}</div>
      <div class="k">From</div><div>${escapeHtml(slipLine)}</div>
      <div class="k">Printed</div><div>${escapeHtml(formatDateTime(opts.createdAt))}</div>
      <div class="k">Crate ID</div><div style="font-family:Menlo,monospace; font-size:12px; color:var(--muted);">${escapeHtml(opts.crateId.slice(0, 8))}</div>
    </div>
  </div>
  <div class="status-strip status-${opts.status}">${statusText}</div>
  ${actionCard}
</div>
<div class="toast" id="toast"></div>
<script>
const CRATE_ID = ${JSON.stringify(opts.crateId)};
function showToast(msg, isError) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2400);
}
async function post(body) {
  const res = await fetch('/api/crate/' + CRATE_ID + '/consume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
async function markEmpty() {
  try {
    await post({ action: 'empty' });
    showToast('Recorded — crate empty');
    setTimeout(() => location.reload(), 700);
  } catch (e) { showToast('Failed: ' + e.message, true); }
}
async function markPartial() {
  const raw = document.getElementById('partial-qty').value;
  const qty = parseFloat(raw);
  if (!Number.isFinite(qty) || qty < 0) { showToast('Enter a number', true); return; }
  try {
    await post({ action: 'partial', consumed_qty: qty });
    showToast('Recorded — partial');
    setTimeout(() => location.reload(), 700);
  } catch (e) { showToast('Failed: ' + e.message, true); }
}
</script>
</body></html>`;
}

export function buildScanNotFoundHtml(crateId: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>Crate not found</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${SHARED_CSS}${SCAN_CSS}</style>
</head><body>
<div class="scan-shell">
  <div class="crate-card">
    <div class="item">Crate not found</div>
    <p class="muted">No crate with ID <code>${escapeHtml(crateId.slice(0, 8))}</code> in the registry. If this label was reprinted or re-taped, ask whoever last handled it.</p>
  </div>
</div>
</body></html>`;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
  } catch { return iso; }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
