import type { DeliverySheetRow } from "./types.js";

// Food Lifeline's bulk-import template for grocery rescue slips.
// One CSV row per (donor, pickup date) with per-category pound totals.

interface DonorMeta {
  banner: string;
  name: string;
  store: string;
  mappedDonor: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postal: string;
}

// Canonical donor codes → Food Lifeline's donor metadata (from the bulkimport
// template they published for RVFB). Any donor_org not in this table is dropped
// because Food Lifeline can't ingest it.
const DONOR_META: Record<string, DonorMeta> = {
  "QFC-MI":  { banner: "12027", name: "QFC - Quality Food Centers", store: "00806", mappedDonor: "D0264", address1: "8421 Se 68Th St",    address2: "", city: "Mercer Island", state: "WA",         postal: "98040" },
  "QFC-BWY": { banner: "12027", name: "QFC - Quality Food Centers", store: "00847", mappedDonor: "D0253", address1: "1401 Broadway",     address2: "", city: "Seattle",        state: "WA",         postal: "98122" },
  "SWY-RB":  { banner: "2576",  name: "Safeway Stores, Inc.",       store: "1508",  mappedDonor: "D1336", address1: "3820 Rainier Ave S", address2: "", city: "Seattle",        state: "WA",         postal: "98118" },
  "SWY-GEN": { banner: "2576",  name: "Safeway Stores, Inc.",       store: "1965",  mappedDonor: "D1487", address1: "9262 Rainier Ave S.",address2: "", city: "Seattle",        state: "WA",         postal: "98118" },
  "HG":      { banner: "D1883", name: "Homegrown Partners",         store: "00001", mappedDonor: "D1883", address1: "9100 15th PL S Suit B", address2: "", city: "Seattle",     state: "Washington", postal: "98108" }
};

// Column order + header text mirror the Food Lifeline template exactly. The
// matcher runs against a normalized item_name (lower, letters only) so it
// tolerates the small variations extractors emit for skeleton rows.
const CATEGORY_COLUMNS: Array<{ header: string; matcher: (n: string) => boolean }> = [
  { header: "Nonfood (Dry) [12-2]",                         matcher: (n) => n === "nonfood" },
  { header: "Coffee Kiosk (Dry) [127-2]",                   matcher: (n) => n === "coffeekiosk" },
  { header: "Bakery (Dry) [1-2]",                           matcher: (n) => n === "bakery" },
  { header: "Dairy (Refrigeration) [4-3]",                  matcher: (n) => n === "dairyjuicealtdairy" || n === "dairy" },
  { header: "Meat (Frozen) [3-4]",                          matcher: (n) => n === "meat" },
  { header: "Canned/Dry Goods (Dry) [125-2]",               matcher: (n) => n === "canneddrygoods" || n === "canned" },
  { header: "Produce (Refrigeration) [2-3]",                matcher: (n) => n === "produce" },
  { header: "Prepared / Perishable (Refrigeration) [10-3]", matcher: (n) => n === "preparedperishable" || n === "prepared" },
  { header: "Frozen Foods (Frozen) [138-4]",                matcher: (n) => n === "frozenfoods" },
  { header: "Non-Meat Protein (Refrigeration) [122-3]",     matcher: (n) => n === "nonmeatprotein" },
  { header: "Mix (Dry) [13-2]",                             matcher: () => false }
];

function normKey(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

function toNumber(v: string | null | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function formatPickupDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

function formatPounds(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}

function csvField(v: string | number | null | undefined): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function knownRescueDonors(): string[] {
  return Object.keys(DONOR_META);
}

export function buildRescueSlipsCsv(params: {
  inboundRows: DeliverySheetRow[];
  from: string;
  to: string;
}): { filename: string; csv: string; slipCount: number } {
  const { inboundRows, from, to } = params;

  type Slip = { donor: string; date: string; totals: number[] };
  const slips = new Map<string, Slip>();

  for (const r of inboundRows) {
    if (r.supplier !== "grocery_rescue") continue;
    if (!r.donor_org || !DONOR_META[r.donor_org]) continue;
    if (!r.delivery_date) continue;
    if (r.delivery_date < from || r.delivery_date > to) continue;

    const key = `${r.donor_org}::${r.delivery_date}`;
    let slip = slips.get(key);
    if (!slip) {
      slip = { donor: r.donor_org, date: r.delivery_date, totals: new Array(CATEGORY_COLUMNS.length).fill(0) };
      slips.set(key, slip);
    }

    const qty = toNumber(r.quantity);
    if (qty === 0) continue;

    const catKey = normKey(r.item_name_normalized ?? r.item_name_raw);
    for (let i = 0; i < CATEGORY_COLUMNS.length; i++) {
      if (CATEGORY_COLUMNS[i].matcher(catKey)) {
        slip.totals[i] += qty;
        break;
      }
    }
  }

  const sorted = Array.from(slips.values()).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.donor.localeCompare(b.donor);
  });

  const header = [
    "Banner Number", "Donor Name", "Store Number", "Mapped Donor Number",
    "Donor Street Address 1", "Donor Street Address 2",
    "Donor City", "Donor State", "Donor Postal Code",
    "Pickup Date",
    ...CATEGORY_COLUMNS.map((c) => c.header)
  ];

  const lines = [header.map(csvField).join(",")];
  for (const slip of sorted) {
    const meta = DONOR_META[slip.donor];
    const row = [
      meta.banner, meta.name, meta.store, meta.mappedDonor,
      meta.address1, meta.address2,
      meta.city, meta.state, meta.postal,
      formatPickupDate(slip.date),
      ...slip.totals.map(formatPounds)
    ];
    lines.push(row.map(csvField).join(","));
  }

  return {
    filename: `grocery-rescue-slips-${from}_to_${to}.csv`,
    csv: lines.join("\n") + "\n",
    slipCount: sorted.length
  };
}
