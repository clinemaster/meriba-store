# 01 — Current MERIBA system assessment

## Assessment scope

This assessment is based on the checked-out `feature/multi-tenant-saas` branch. It is a source-code review only: no production connection, database inspection, migration, configuration change, or application-code change was made. The repository README describes MERIBA as in development; production data and deployment state were not independently verified.

## Architecture and configuration

The project is a Django 5.2 / Django REST Framework API, Next.js 15 / React 19 / TypeScript frontend, and PostgreSQL application. Django's `config/settings.py` installs `core`, `accounts`, `catalog`, `inventory`, `trading`, `sales`, `finance`, `reports`, and `history`; it uses the custom `accounts.User`, session authentication, CSRF, a deny-by-default DRF permission, and PostgreSQL. `config/urls.py` exposes the app APIs below `/api/v1/`. The browser calls Next.js, which rewrites `/api/*` to Django (`frontend/next.config.mjs`).

The backend's documented responsibility is business rules and records; the frontend is a screen client (`docs/ARCHITECTURE.md`). The code follows that direction through service modules such as `sales/services.py`, `inventory/services.py`, `trading/services.py`, and `catalog/costing.py`, called from DRF views.

| App / area | Existing responsibilities | Tenant-relevant findings |
|---|---|---|
| `core` | `Branch`, per-branch `BusinessSettings`, append-only `AuditLog`, setup/go-live, request logging | No business entity. `core/services.py:get_branch()` selects the first active branch, not a branch authorized for the current user. |
| `accounts` | Custom Django `User`, sign-in, password change/reset, user administration, permissions | A single global `role` (`OWNER`, `ACCOUNTANT`, `CASHIER`) lives on the user. Memberships and branch grants do not exist. |
| `catalog` | `Category`, `Product`, `ProductUnit`, product table and costing helpers | Catalog rows are global. Product/SKU, category name, serial number and product-unit identifiers are not tenant-scoped. |
| `inventory` | Per-branch stock balances, append-only movement ledger, counts, adjustments, damage and alerts | Stock and movements carry a branch; products remain global. Existing unique/check constraints protect one balance per branch/product and non-negative stock. |
| `trading` | Business days, cashier shifts, payment totals, daily sheet, opening balance and corrections | Days belong to branches. Constraints limit one open day per branch, one cashier shift per cashier/day and one open shift per cashier globally. |
| `sales` | Sales/POS, sale item snapshots, payment methods/providers, payments, refunds and reconciliation | Sales carry a branch/day/shift and cashier. Methods/providers are global; several identifiers are globally unique. |
| `finance` | Suppliers, goods receipts, receipt imports and expenses | Receipts/expenses/imports carry a branch; suppliers are global. Receipt lines refer to global products. |
| `reports` | Sales, stock, damage, purchasing, expense, closing, financial and payment reports/exports | Some queries scope to `get_branch()`, while other aggregations use sales/payment/product tables without an explicit selected-branch filter. |
| `history` | Historical workbook batches, source products, dated historical rows, review decisions and acceptance | Stored as a separate reference workflow, but ownership keys are global and not associated with a business. |

## Verified capabilities and absence of features

- **Authentication:** username/password, Django session cookie, CSRF, rate-limited login and password-change flow. Password policy and secure cookie settings are configured in `config/settings.py`. There is no token-based client authentication.
- **Roles and user management:** Owner, Accountant and Cashier are the only application roles found. Owner-only account management creates, edits, deactivates and resets global user accounts. The last active Owner safeguard is global rather than per business.
- **Products and inventory:** products and optional verified sale units; opening stock counts; branch balances; movement ledger; stock adjustments and damage/reversal records; stock alerts; delivery receipt posting through the inventory service. Historical workbook data is deliberately not treated as live stock.
- **Purchases and expenses:** goods receipts post stock movements and update weighted-average cost; expenses can affect the relevant cashier cash drawer. These are operational financial records, not an accounts-payable or general-ledger subsystem.
- **POS and sales:** server-side prices, unit conversion, idempotency key, receipt sequence, payment validation, stock movements and audit in a transaction. Sales and sale items cannot be edited/deleted through the normal application flow; cancellation is recorded as a void. Refunds are separate records and can restock through a ledger movement.
- **Payments:** configurable categories/providers; cash, mobile and bank examples; split tender; tender/change validation; payment reconciliation and closing snapshots. Payment categories/providers are currently shared globally.
- **Business days and closing:** a business day per branch/date, one open day per branch, cashier shifts and closing review. A business-day cumulative monetary sales balance is not the same as cash or inventory.
- **Reports and exports:** the report view contains daily sales, sales by product/cashier, payment summary, stock on hand, low stock, stock daily, damage reports, purchases, expenses, closings, financial summary and payment reconciliation. CSV and, in relevant endpoints, spreadsheet exports are implemented.
- **Historical import:** workbook preview/dry-run, import, product mapping, exception and unclassified-row review, and explicit acceptance. The module states it is reference data only.
- **Offline POS / synchronization:** no offline sale queue, service worker, IndexedDB synchronization protocol or replay/sync API was found. `localStorage` use in the frontend is for table-column preferences, not sales.
- **Customers:** no customer model or customer-management workflow was found.
- **Background jobs:** no Celery, RQ, Dramatiq, or similar worker framework was found in the inspected requirements/code. Existing work is request-driven.

## Important existing business logic to preserve

1. `inventory/services.py` is the stock posting path. It writes movement history and updates a branch/product balance in the same transaction. Movement, sales, adjustment, and receipt records have idempotency/uniqueness safeguards.
2. Sales are coupled to branch day/shift, product pricing, payment methods, stock and audit records. Preserve those transaction boundaries and database constraints.
3. `trading/models.py` enforces day arithmetic and one-open-day-per-branch. `trading/services.py` advances the branch's cumulative sales chain.
4. The code has two distinct cost fields/behaviors. `catalog/costing.py` maintains `Product.average_cost` on receipts and explicitly says it is informational. `sales/services.py` reads `Product.cost_price` when saving a sale's cost snapshot, reflecting the documented owner decision to use that day's purchase price for profit. Do not silently substitute average cost in a multi-tenant conversion.
5. Append-only records and `PROTECT` foreign keys preserve sale, refund, inventory and audit history. Preserve these semantics.

## Main single-business assumptions

| Assumption | Evidence | Consequence for SaaS |
|---|---|---|
| The first active branch is “the shop” | `core/services.py:get_branch()` | Must be replaced by authenticated, membership-validated business/branch context; never use first-row fallback. |
| A user has one role for the whole application | `accounts/models.py`, `accounts/permissions.py`, frontend `types.ts` and `nav.ts` | Role and permissions must be evaluated per business membership (and optional branch grant). |
| There is one business settings record per branch, with a MERIBA default | `core/models.py`, `core/migrations/0002_seed_main_branch.py` | Separate tenant-wide settings from branch-specific settings and assign the existing branch/settings to MERIBA. |
| Product catalog/configuration is global | `catalog/models.py`; global serializers/querysets in `catalog/views.py` | Products/categories need business ownership; stock remains branch-specific. |
| Payment configuration and suppliers are shared | `sales/models.py:PaymentMethod/PaymentProvider`; `finance/models.py:Supplier` | Scope to business; prevent using another tenant's payment config or supplier. |
| Existing role permission is enough to authorize records | `accounts/permissions.py` and views | Add tenant membership and branch authorization to every view, service, relation, report and export. |
| A cashier cannot be assigned to more than one open shift | `trading/models.py:CashierShift` conditional unique constraint | Decide and implement a tenant-aware uniqueness policy for users operating multiple businesses/branches. |
| Historical source keys, receipt numbers and request keys are globally unique | Catalog, history, sales and finance models | Re-evaluate uniqueness scope and preserve existing key values during constraint transition. |

## Existing tests and migrations

There are app migrations under each of the existing Django apps, including the main-branch seed and multiple later schema/business-rule migrations. Backend tests are PostgreSQL-oriented (`backend/tests/conftest.py`) and cover API docs, permissions, back office, concurrency, daily sheet, damage, closing, history, inventory, payments, product table, receipt import, sales and stock levels. The test fixture currently creates a branch and global payment methods, and creates users with one global role; it will need tenant-aware fixtures before tenant behavior can be reliably tested. Frontend Vitest tests cover pages/components and navigation; Playwright E2E tests cover trading day, Excel history and back navigation.

## Source map

- Project overview and design: `README.md`, `docs/ARCHITECTURE.md`, `docs/DATABASE_DESIGN.md`, `docs/OPEN_DECISIONS.md`
- Configuration and API routing: `backend/config/settings.py`, `backend/config/urls.py`
- Models: `backend/core/models.py`, `backend/accounts/models.py`, `backend/catalog/models.py`, `backend/inventory/models.py`, `backend/trading/models.py`, `backend/sales/models.py`, `backend/finance/models.py`, `backend/history/models.py`
- Tenant-sensitive services/API: `backend/core/services.py`, `backend/accounts/permissions.py`, and app `views.py`/`services.py` files above
- Frontend: `frontend/src/app/`, `frontend/src/components/AppShell.tsx`, `frontend/src/components/SidebarNav.tsx`, `frontend/src/lib/api.ts`, `frontend/src/lib/auth.tsx`, `frontend/src/lib/types.ts`, `frontend/src/lib/nav.ts`
- Existing tests/migrations: `backend/tests/`, `backend/*/migrations/`, `frontend/src/**/*.test.*`, `frontend/e2e/`
