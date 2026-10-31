export type Role = "OWNER" | "ACCOUNTANT" | "CASHIER";

export type User = {
  id: number; username: string; full_name: string; display_name: string; role: Role;
  is_active: boolean; must_change_password: boolean; last_login: string | null;
};

/** A product's stock level, worked out on the server from its live stock and its own warning levels. */
export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "CRITICAL" | "OUT_OF_STOCK";

export type Product = {
  id: number; sku: string; name: string; category: number | null; category_name: string; brand: string;
  package_size: string; pack_description: string; base_unit: string; selling_price: string;
  is_active: boolean; stock_on_hand: string; stock_status: StockStatus;
  cost_price?: string | null; reorder_point?: string; critical_point?: string; target_stock?: string;
  volume_ml: number | null; bottles_per_unit: number | null;
  average_cost?: string | null; cost_provisional?: boolean;
  units: { id: number; name: string; factor: string; selling_price: string; is_verified: boolean; is_active: boolean }[];
};

/** One line of the product table. Amounts and quantities arrive as plain number text; blank means "not known". */
export type ProductRow = {
  id: number; serial_number: number | null; sku: string; name: string; sold_by: string; volume_ml: number | null; bottles_per_unit: number | null; is_active: boolean;
  opening_stock: string; incoming: string; other_out: string; total_item_stock: string; sales: string; closing_stock: string;
  purchase_price: string | null; purchase_price_provisional: boolean; purchase_price_entered: string | null; selling_price: string;
  total_sales: string; cost_of_goods_sold: string | null; profit: string | null; profit_status: "OK" | "PROVISIONAL" | "UNAVAILABLE"; stock: string;
  stock_status: StockStatus;
};

export type ProductTable = {
  date_from: string; date_to: string; count: number; page: number; page_size: number; pages: number; results: ProductRow[];
  totals: { total_sales: string; profit: string; profit_unavailable_for: number; profit_provisional_for: number };
  sold_by_options: string[];
};

export type ProductDetails = {
  product: Product; date_from: string; date_to: string; figures: ProductRow;
  movements: { id: number; date: string; created_at: string; type: string; change: string; balance_after: string; by: string; reason: string }[];
  purchases: { date: string; supplier: string; reference: string; quantity: string; unit_cost: string | null; average_before: string | null; average_after: string | null }[];
  changes: { when: string; by: string; what: string; before: unknown; after: unknown }[];
};

export type PaymentProvider = {
  id: number; category: number; category_name: string; code: string; name: string; description: string;
  is_active: boolean; sort_order: number; created_at: string; updated_at: string; in_use: boolean;
};

/** A payment category (Cash, Mobile Money, Bank, ...). Cashiers receive only the categories and providers switched on. */
export type PaymentMethod = {
  id: number; code: string; name: string; description?: string; icon?: string; is_cash: boolean; requires_provider?: boolean;
  reference_label: string; is_active: boolean; sort_order?: number; providers?: PaymentProvider[]; in_use?: boolean;
  created_at?: string; updated_at?: string;
};

export type Sale = {
  id: number; receipt_number: string; status: "COMPLETED" | "VOIDED"; status_label: string; business_date: string;
  created_at: string; cashier_name: string; subtotal: string; total: string; amount_tendered: string; change_due: string;
  items: { id: number; product_name: string; unit_name: string; quantity: string; unit_price: string; line_total: string; refunded_quantity?: string }[];
  payments: { id: number; method_name: string; is_cash: boolean; amount: string; tendered: string; reference: string; status: string; provider_name?: string; method_icon?: string }[];
  void_reason: string; voided_by_name: string; already_saved?: boolean; refunded_total?: string;
  refunds?: { id: number; business_date: string; total: string; method_name: string; provider_name?: string; reason: string; created_by_name: string }[];
};

export type Day = {
  id: number; date: string; status: "OPEN" | "CLOSED"; status_label: string; opening_cumulative_sales: string;
  gross_sales: string; discounts: string; voids: string; refunds: string; net_sales: string;
  closing_cumulative_sales: string | null; closed_at: string | null; adjustments: string;
  corrections: { id: number; amount: string; reason: string; created_at: string; authorised_by: string; closing_before: string; closing_after: string }[];
  /** Owner changes to this day's opening balance, newest first. */
  opening_changes: { id: number; opening_before: string; opening_after: string; reason: string; created_at: string; authorised_by: string }[];
  /** The payment reconciliation kept when the day was closed. */
  payment_snapshot?: { metrics: PaymentMetrics; categories: PaymentCategoryTotal[] } | null;
};

export type PaymentMetrics = {
  sale_count: number; voided_count: number; payment_count: number; refund_count: number;
  gross_sales: string; discounts: string; cancellations: string; refunds: string; adjustments: string; net_sales: string;
  payments_collected: string; refunds_issued: string; net_collections: string; outstanding_receivables: string;
  expected_collections: string; reconciliation_difference: string;
};

export type PaymentLine = {
  id: number | null; name: string; is_active: boolean; amount: string; count: number; verified: string; refunds: string; refund_count: number; net: string;
};

export type PaymentCategoryTotal = PaymentLine & {
  code: string; icon: string; is_cash: boolean; requires_provider: boolean; providers: PaymentLine[]; unassigned: number;
};

export type PaymentFilters = {
  date_from: string; date_to: string; category: number | "none" | null; provider: number | "none" | null; branch: number | null;
  cashier: number | null; status: string; search: string;
};

export type PaymentSummary = {
  filters: PaymentFilters; metrics: PaymentMetrics; categories: PaymentCategoryTotal[]; group: "day" | "week" | "month";
  trend: { period: string; label: string; total: string; by_category: Record<string, string> }[];
  checks: { providers_match_categories: boolean; categories_match_total: boolean; reconciled: boolean };
  options: { branches: { id: number; name: string }[]; cashiers?: { id: number; name: string }[] };
  unassigned_total?: number; today: string;
};

export type PaymentTransaction = {
  id: number; kind: "payment" | "refund"; number: string; sale: number; receipt_number: string; date_time: string; business_date: string;
  cashier: string; branch: string; category_id: number; category: string; category_icon: string; provider_id: number | null; provider: string;
  amount: string; reference: string; status_code: string; status: string; needs_provider: boolean; reason?: string;
};

export type PaymentTransactionPage = {
  kind: "payment" | "refund"; count: number; page: number; page_size: number; pages: number;
  totals: { amount: string; count: number }; filters: PaymentFilters; results: PaymentTransaction[];
};

export type ProviderTotal = { provider: number | null; name: string; amount: string; count: number };
export type PaymentTotal = {
  method: number; name: string; is_cash: boolean; amount: string; count: number; is_verified?: boolean; code?: string; icon?: string;
  providers?: ProviderTotal[];
};

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
export type StockLevelCounts = { counts: Record<StockStatus, number>; labels: Record<StockStatus, string>; total: number };

export type StockAlert = {
  id: number; created_at: string; product: number; product_name: string; unit: string;
  status_before: StockStatus; status: StockStatus; status_label: string; quantity: string; current_status: StockStatus;
};
