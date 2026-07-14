import { FONT_HEAD_LINKS, SHARED_CSS } from "./ui-styles.js";
import type { InKindDonationSubmission } from "./sheets.js";

const DONATE_CSS = `
.donate-shell { max-width: 720px; margin: 0 auto; padding: 32px 24px 64px; }
.donate-header { margin-bottom: 24px; }
.donate-header h1 { font-size: 32px; letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 700; }
.donate-header p { margin: 0; color: #4a5568; font-size: 15px; }
form.donate { display: flex; flex-direction: column; gap: 32px; }
fieldset.card {
  border: 1px solid #e6e8eb; border-radius: 16px; background: #fff;
  padding: 24px; margin: 0;
}
fieldset.card legend {
  padding: 4px 12px; margin-left: 12px; font-size: 12px; letter-spacing: 0.06em;
  text-transform: uppercase; color: #6b7580; font-weight: 700; background: #eef0f4;
  border-radius: 999px;
}
.row { display: flex; flex-direction: column; gap: 6px; margin-top: 16px; }
.row:first-of-type { margin-top: 12px; }
.row label { font-size: 13px; font-weight: 600; color: #0a1626; }
.row .hint { font-size: 12px; color: #6b7580; }
.row input[type=text],
.row input[type=email],
.row input[type=number],
.row textarea,
.row select {
  width: 100%; padding: 10px 12px; border: 1px solid #e6e8eb; border-radius: 8px;
  font-size: 15px; font-family: inherit; background: #fff; color: #0a1626;
}
.row textarea { min-height: 72px; resize: vertical; }
.row input:focus, .row textarea:focus, .row select:focus {
  outline: none; border-color: #635bff; box-shadow: 0 0 0 3px rgba(99,91,255,0.15);
}
.checkbox-row { display: flex; align-items: center; gap: 10px; margin-top: 16px; }
.checkbox-row input[type=checkbox] { width: 18px; height: 18px; }
.checkbox-row label { font-size: 14px; font-weight: 500; color: #0a1626; }
.two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
.two-col .row { margin-top: 0; }
.actions { display: flex; justify-content: flex-end; gap: 12px; }
.btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 12px 22px; border-radius: 999px; font-weight: 600; font-size: 14px;
  border: 1px solid transparent; cursor: pointer; font-family: inherit;
}
.btn-primary { background: #0a1626; color: #fff; }
.btn-primary:hover { background: #635bff; }
.hidden { display: none !important; }
.notice {
  border-radius: 12px; padding: 14px 16px; font-size: 14px; margin-bottom: 20px;
}
.notice.ok { background: #ecfdf5; color: #065f46; border: 1px solid #a7f3d0; }
.notice.err { background: #fef2f2; color: #991b1b; border: 1px solid #fecaca; }
@media (max-width: 640px) {
  .two-col { grid-template-columns: 1fr; }
}
`;

export interface DonateFormOptions {
  notice?: { kind: "ok" | "err"; text: string };
  staffEmail?: string | null;
}

export function buildDonateHtml(opts: DonateFormOptions = {}): string {
  const { notice, staffEmail } = opts;
  const noticeHtml = notice
    ? `<div class="notice ${notice.kind}">${escapeHtml(notice.text)}</div>`
    : "";
  const staffLine = staffEmail
    ? `<p>Staff: <strong>${escapeHtml(staffEmail)}</strong></p>`
    : "";
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><title>In-kind donation — Loadslip</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
${FONT_HEAD_LINKS}
<style>${SHARED_CSS}${DONATE_CSS}</style>
</head><body>
<div class="donate-shell">
  <div class="donate-header">
    <h1>In-kind donation intake</h1>
    <p>Hand the device to the donor for the top section, then finish filling it out yourself.</p>
    ${staffLine}
  </div>
  ${noticeHtml}
  <form class="donate" method="POST" action="/donate">
    <fieldset class="card">
      <legend>Donor</legend>
      <div class="row">
        <label for="donor_name">Name</label>
        <input type="text" id="donor_name" name="donor_name" autocomplete="name">
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="donor_anonymous" name="donor_anonymous" value="on">
        <label for="donor_anonymous">Prefer to remain anonymous</label>
      </div>
      <div class="row">
        <label for="donor_email">Email <span class="hint">(required)</span></label>
        <input type="email" id="donor_email" name="donor_email" required autocomplete="email">
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="send_receipt" name="send_receipt" value="on">
        <label for="send_receipt">Please email me a donation receipt</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="is_food_drive" name="is_food_drive" value="on" onchange="document.getElementById('food-drive-org').classList.toggle('hidden', !this.checked)">
        <label for="is_food_drive">This is from a food drive</label>
      </div>
      <div class="row hidden" id="food-drive-org">
        <label for="food_drive_org">Food drive / organization name</label>
        <input type="text" id="food_drive_org" name="food_drive_org">
      </div>
    </fieldset>

    <fieldset class="card">
      <legend>Staff — items received</legend>
      <div class="two-col">
        <div class="row">
          <label for="category">Type</label>
          <select id="category" name="category" required>
            <option value="food">Food</option>
            <option value="non_food">Non-food</option>
          </select>
        </div>
        <div class="row">
          <label for="approx_weight_lb">Weight (lb)</label>
          <input type="number" id="approx_weight_lb" name="approx_weight_lb" min="0" step="0.1">
        </div>
      </div>
      <div class="two-col">
        <div class="row">
          <label for="quantity">Count</label>
          <input type="number" id="quantity" name="quantity" min="0" step="1">
        </div>
        <div class="row">
          <label for="unit">Unit</label>
          <select id="unit" name="unit">
            <option value="">—</option>
            <option value="bag">Bag(s)</option>
            <option value="box">Box(es)</option>
            <option value="case">Case(s)</option>
            <option value="pallet">Pallet(s)</option>
            <option value="ea">Item(s)</option>
          </select>
        </div>
      </div>
      <div class="row">
        <label for="notes">Notes</label>
        <textarea id="notes" name="notes" placeholder="Anything unusual about the donation"></textarea>
      </div>
    </fieldset>

    <div class="actions">
      <button type="submit" class="btn btn-primary">Log donation</button>
    </div>
  </form>
</div>
</body></html>`;
}

export interface ParsedDonateForm {
  submission: Omit<InKindDonationSubmission, "submissionId" | "submittedBy">;
  errors: string[];
}

export function parseDonateFormBody(body: string): ParsedDonateForm {
  const params = new URLSearchParams(body);
  const errors: string[] = [];
  const donorAnonymous = params.get("donor_anonymous") === "on";
  const donorName = (params.get("donor_name") ?? "").trim();
  const donorEmail = (params.get("donor_email") ?? "").trim();
  const sendReceipt = params.get("send_receipt") === "on";
  const isFoodDrive = params.get("is_food_drive") === "on";
  const foodDriveOrg = isFoodDrive ? (params.get("food_drive_org") ?? "").trim() || null : null;
  const categoryRaw = (params.get("category") ?? "").trim();
  const category: "food" | "non_food" = categoryRaw === "non_food" ? "non_food" : "food";
  const weightRaw = (params.get("approx_weight_lb") ?? "").trim();
  const approxWeightLb = weightRaw === "" ? null : Number(weightRaw);
  const qtyRaw = (params.get("quantity") ?? "").trim();
  const quantity = qtyRaw === "" ? null : Number(qtyRaw);
  const unit = (params.get("unit") ?? "").trim() || null;
  const notes = (params.get("notes") ?? "").trim() || null;

  if (!donorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) {
    errors.push("A valid donor email is required.");
  }
  if (!donorAnonymous && !donorName) {
    errors.push("Enter the donor's name, or check the anonymous box.");
  }
  if (approxWeightLb !== null && !Number.isFinite(approxWeightLb)) {
    errors.push("Weight must be a number.");
  }
  if (quantity !== null && !Number.isFinite(quantity)) {
    errors.push("Count must be a number.");
  }

  return {
    submission: {
      donorName,
      donorEmail,
      donorAnonymous,
      sendReceipt,
      isFoodDrive,
      foodDriveOrg,
      category,
      approxWeightLb,
      quantity,
      unit,
      notes
    },
    errors
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
