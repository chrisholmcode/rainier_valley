export type Supplier = "carusos" | "charlies" | "nw_harvest" | "pacific" | "unknown";

export type DocumentType = "invoice" | "manifest" | "warehouse_posted_shipment" | "dock_photo" | "unknown";

export interface LineItem {
  item_code_raw: string | null;
  item_name_raw: string | null;
  item_name_normalized: string | null;
  quantity: number | null;
  quantity_raw: string | null;
  unit: "case" | "ct" | "lb" | "oz" | "ea" | "bushel" | "other" | null;
  pack_size_raw: string | null;
  category: "produce" | "meat_protein" | "dairy" | "shelf_stable" | "frozen" | "non_food" | "unknown";
  unit_cost: number | null;
  line_total: number | null;
  is_fee: boolean;
  notes: string | null;
  confidence: number;
}

export interface FeeItem {
  description: string;
  amount: number;
}

export interface ExtractionResult {
  document_type: DocumentType;
  supplier: Supplier;
  delivery_date: string | null;
  invoice_or_order_number: string | null;
  destination_org: string | null;
  line_items: LineItem[];
  fees: FeeItem[];
  totals: {
    subtotal: number | null;
    tax: number | null;
    grand_total: number | null;
  };
  source_warnings: string[];
}
