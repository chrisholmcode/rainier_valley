export type Supplier = "carusos" | "charlies" | "costco" | "food_lifeline" | "grand_central" | "grocery_rescue" | "in_kind" | "nw_harvest" | "pacific" | "terrebonne" | "weigelt" | "unknown";

export type ProgramType = "home_delivery" | "in_person_shopping" | "pre_made_bags" | "unknown";

// ── Assistant / conversation types ────────────────────────────────────────────

export type CorrectionSheet = "eod" | "delivery";

export type ConversationContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string | ConversationContentBlock[];
}

export interface ThreadHistory {
  threadTs: string;
  channel: string;
  messages: ConversationMessage[];
  lastActivityAt: number;
}

export interface PendingAssistantCorrection {
  correctionId: string;
  channel: string;
  threadTs: string;
  summaryMessageTs: string;
  sheet: CorrectionSheet;
  rowIndex: number;
  columnName: string;
  oldValue: string | null;
  newValue: string | number | boolean | null;
  reason: string;
  requestedBy: string;
  expiresAt: number;
}

export interface EodSheetRow {
  rowIndex: number;
  recorded_at: string;
  date: string;
  item_name_raw: string | null;
  item_name_normalized: string | null;
  quantity: string | null;
  quantity_raw: string | null;
  unit: string | null;
  category: string | null;
  notes: string | null;
  confidence: string | null;
  source: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  recorded_by: string | null;
  warnings_json: string | null;
  program_type: ProgramType | null;
  approved_at: string | null;
  approved_by: string | null;
  photo_url: string | null;
}

export interface DeliverySheetRow {
  rowIndex: number;
  created_at: string;
  supplier: string;
  document_type: string;
  invoice_date: string | null;
  delivery_date: string | null;
  invoice_or_order_number: string | null;
  destination_org: string | null;
  item_code_raw: string | null;
  item_name_raw: string | null;
  item_name_normalized: string | null;
  quantity_ordered: string | null;
  quantity: string | null;
  quantity_raw: string | null;
  unit: string | null;
  pack_size_raw: string | null;
  approx_weight: string | null;
  category: string | null;
  unit_cost: string | null;
  line_total: string | null;
  confidence: string | null;
  is_fee: string | null;
  notes: string | null;
  photo_url: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  uploaded_by: string | null;
  warnings_json: string | null;
  donor_org: string | null;
  is_donation: string | null;
  approved_at: string | null;
  approved_by: string | null;
  donor_name: string | null;
  donor_email: string | null;
  donor_anonymous: string | null;
  send_receipt: string | null;
  is_food_drive: string | null;
  is_food: string | null;
}

export interface EodLineItem {
  item_name_raw: string | null;
  item_name_normalized: string | null;
  quantity: number | null;
  quantity_raw: string | null;
  unit: "case" | "bag" | "pallet" | "lb" | "oz" | "ct" | "ea" | "other" | null;
  category: "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown";
  notes: string | null;
  confidence: number;
  program_type: ProgramType | null;
}

export interface EodExtractionResult {
  date: string | null;
  line_items: EodLineItem[];
  source_warnings: string[];
}

export type DocumentType = "invoice" | "manifest" | "warehouse_posted_shipment" | "dock_photo" | "unknown";

export interface LineItem {
  item_code_raw: string | null;
  item_name_raw: string | null;
  item_name_normalized: string | null;
  quantity_ordered: number | null;
  quantity: number | null;
  quantity_raw: string | null;
  unit: "case" | "ct" | "lb" | "oz" | "ea" | "bushel" | "other" | null;
  pack_size_raw: string | null;
  approx_weight: number | null;
  category: "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown";
  unit_cost: number | null;
  line_total: number | null;
  is_fee: boolean;
  notes: string | null;
  confidence: number;
}

export interface FeeItem {
  description: string;
  amount: number | null;
}

export type PromptSuggestionStatus = "pending" | "approved" | "rejected";

export interface PromptSuggestionRow {
  rowIndex: number;
  created_at: string;
  submitted_by: string;
  supplier: string;
  slip_photo_url: string | null;
  suggestion_text: string;
  status: PromptSuggestionStatus;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_notes: string | null;
}

export interface ExtractionTrace {
  filename: string;
  supplierHint: string;
  model: string;
  thinking: string;
  rawToolInput: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
}

export interface ExtractionResult {
  document_type: DocumentType;
  supplier: Supplier;
  invoice_date: string | null;
  delivery_date: string | null;
  invoice_or_order_number: string | null;
  destination_org: string | null;
  donor_org: string | null;
  is_donation: boolean | null;
  line_items: LineItem[];
  fees: FeeItem[];
  totals: {
    subtotal: number | null;
    tax: number | null;
    grand_total: number | null;
  };
  source_warnings: string[];
}
