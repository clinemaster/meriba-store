export type Role = "OWNER" | "ACCOUNTANT" | "CASHIER";

export type User = {
  id: number; username: string; full_name: string; display_name: string; role: Role;
  is_active: boolean; must_change_password: boolean; last_login: string | null;
};

export type Product = {
  id: number; sku: string; name: string; category: number | null; category_name: string; brand: string;
  package_size: string; pack_description: string; base_unit: string; barcode: string; selling_price: string;
  is_active: boolean; stock_on_hand: string; stock_status: "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";
  cost_price?: string | null; reorder_point?: string; target_stock?: string;
};

export type PaymentMethod = { id: number; code: string; name: string; is_cash: boolean; reference_label: string; is_active: boolean };

export type Sale = {
  id: number; receipt_number: string; status: "COMPLETED" | "VOIDED"; status_label: string; business_date: string;
  created_at: string; cashier_name: string; subtotal: string; total: string; amount_tendered: string; change_due: string;
  items: { id: number; product_name: string; unit_name: string; quantity: string; unit_price: string; line_total: string; refunded_quantity?: string }[];
  payments: { id: number; method_name: string; is_cash: boolean; amount: string; tendered: string; reference: string; status: string }[];
  void_reason: string; voided_by_name: string; already_saved?: boolean; refunded_total?: string;
  refunds?: { id: number; business_date: string; total: string; method_name: string; reason: string; created_by_name: string }[];
};

export type Day = {
  id: number; date: string; status: "OPEN" | "CLOSED"; status_label: string; opening_cumulative_sales: string;
  gross_sales: string; discounts: string; voids: string; refunds: string; net_sales: string;
  closing_cumulative_sales: string | null; closed_at: string | null; adjustments: string;
  corrections: { id: number; amount: string; reason: string; created_at: string; authorised_by: string; closing_before: string; closing_after: string }[];
};

export type PaymentTotal = { method: number; name: string; is_cash: boolean; amount: string; count: number; is_verified?: boolean; code?: string };

export type Shift = {
  id: number; business_date: string; cashier: number; cashier_name: string; status: string; status_label: string;
  opening_float: string; opened_at: string; closed_at: string | null; sales_total: string | null;
  expected_cash: string | null; counted_cash: string | null; cash_variance: string | null; closing_note: string;
  cash_refunds: string; cash_paid_out: string;
  reviewed_by_name: string; review_note: string; payment_totals: PaymentTotal[]; day?: Day;
};

export type ShiftFigures = {
  sale_count: number; sales_total: string; voided_count: number; voided_total: string; payments: PaymentTotal[];
  opening_float: string; cash_sales: string; cash_refunds: string; cash_paid_out: string; expected_cash: string;
};

export type DayFigures = {
  sale_count: number; gross_sales: string; discounts: string; voids: string; refunds: string; adjustments: string; net_sales: string;
  opening_cumulative_sales: string; closing_cumulative_sales: string;
};

export type CurrentDay = {
  is_live: boolean; today: string; day: Day | null; shift: Shift | null; shift_figures: ShiftFigures | null;
  day_needs_closing: boolean; closed_shift_today: Shift | null; next_opening_cumulative_sales?: string;
  day_figures?: DayFigures; open_shifts?: Shift[];
};

export type ShopSettings = {
  branch_name: string; branch_code: string; currency_code: string; receipt_header: string; receipt_footer: string;
  split_payments_enabled: boolean; cash_variance_tolerance: string; opening_cumulative_sales: string; is_live: boolean;
};

export type SetupStatus = {
  is_live: boolean; ready_to_go_live: boolean; opening_cumulative_sales: string; went_live_at?: string | null;
  prepared_opening_cumulative_sales: string | null; opening_balance_as_of: string | null; opening_balance_note: string;
  opening_balance_prepared_by: string;
  opening_stock: { approved: boolean; pending: boolean; uncounted: number; uncounted_names: string[]; complete: boolean };
  steps: { key: string; title: string; done: boolean; detail: string }[];
};

export type OpeningCount = {
  id: number; count_date: string; counted_by_name: string; note: string; status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  status_label: string; created_at: string; prepared_by_name: string; reviewed_by_name: string; reviewed_at: string | null; review_note: string;
  lines: { product: number; product_name: string; unit: string; counted_quantity: string; reference_quantity: string | null;
           reference_source: string; variance: string | null; approved_quantity: string | null; movement: number | null }[];
};