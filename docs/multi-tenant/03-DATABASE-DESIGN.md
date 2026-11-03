# 03 — Proposed database design

## Design principles

- Preserve existing table identities, primary keys and immutable records.
- Add tenant ownership additively, backfill, validate, then enforce `NOT NULL` and revised uniqueness in later migrations.
- Keep tenant-wide configuration separate from branch-specific stock and financial operations.
- Prefer database constraints for arithmetic, uniqueness and same-tenant relationships; retain serializer/service checks for useful errors.
- Never infer tenant ownership from user role or an arbitrary request parameter.

## Proposed relationships

```text
accounts_user (existing global identity)
  ├──1:1 platform_administrator [optional]
  └──< business_membership >── core_business
          ├──< branch_membership >── core_branch
          └──< business_invitation

core_business
  ├──1:1 business_settings
  ├──< tenant_subscription >── subscription_plan
  ├──< core_branch ──1:1 branch_settings
  │      ├──< inventory_stockbalance >── catalog_product
  │      ├──< inventory_inventorymovement >── catalog_product
  │      ├──< trading_businessday ──< trading_cashiershift
  │      │                              └──< trading_shiftpaymenttotal >── sales_paymentmethod
  │      ├──< sales_sale ──< sales_saleitem >── catalog_product
  │      │        ├──< sales_payment >── sales_paymentmethod/provider
  │      │        └──< sales_refund >── sales_refunditem
  │      ├──< finance_goodsreceipt ──< finance_goodsreceiptline >── catalog_product
  │      └──< finance_expense >── sales_paymentmethod
  ├──< catalog_category ──< catalog_product ──< catalog_productunit
  ├──< finance_supplier
  ├──< sales_paymentmethod ──< sales_paymentprovider
  ├──< core_auditlog / history_importbatch and related history rows
  └──< platform_auditlog
```

`Customer` is intentionally omitted: no customer model or customer workflow exists today. Add one only with a separately approved product requirement.

## Proposed table changes

| Entity/table | Proposed ownership and constraints |
|---|---|
| `core_business` | New tenant root; stable PK, unique normalized slug/code, status choices and lifecycle timestamps. |
| `accounts_businessmembership` | New; FK to existing user and business, unique `(business_id, user_id)`, active/status, role/permissions. Index `(user_id, status)` and `(business_id, status)`. |
| `accounts_branchmembership` | New optional branch grants linked to membership and branch; unique membership/branch. Enforce that branch and membership business match. |
| `core_businesssettings` | One-to-one to business for currency (default `TZS`), locale and business identity. Migrate appropriate fields from current per-branch `BusinessSettings`. |
| `core_branch` | Add nullable `business_id` during transition, then required. Preserve branch PK; decide whether branch code is unique per business or globally. |
| `core_branchsettings` | New or a carefully staged replacement/split for current `BusinessSettings`; one-to-one with branch for branch-level receipt, tolerance, time-zone and opening/go-live data. Preserve existing settings values exactly. |
| `catalog_category` | Add business FK. Replace global unique category name with normalized `(business_id, name)` uniqueness if product policy allows duplicate names across businesses. |
| `catalog_product` | Add business FK. Replace global SKU uniqueness with `(business_id, normalized_sku)`; serial number uniqueness should be scoped or redefined with historical-source behavior explicitly preserved. |
| `catalog_productunit` | Inherits business from product. Ensure product and unit are always queried/created under the owning business. |
| `sales_paymentmethod/provider` | Add business FK directly to method; provider inherits through method. Scope method code/name uniqueness and provider code/name uniqueness to a business/method. Keep historic payment provider-name snapshots. |
| `finance_supplier` | Add business FK and business-scoped supplier name uniqueness. |
| Branch operational tables | Add `business_id` (or use branch as the canonical tenant FK where RLS/query isolation design permits) to stock balances/movements/counts/alerts, trading days/shifts/totals, sales/items/payments/refunds, receipts/expenses/imports. If duplicated, enforce `business_id = branch.business_id`. |
| `core_auditlog` | Add nullable then required `business_id` for tenant events; retain platform/auth events with an explicit platform/system classification if they do not belong to one business. Preserve actor username snapshots. |
| `history` tables | Add business ownership to import batch and all directly addressable review/source rows, or derive via an owned parent with strict parent-scoped querysets. Existing MERIBA workbook history maps to MERIBA. |
| `platform_administrator` | New one-to-one to existing user, independent of tenant membership. Add MFA/access policy before production platform access. |
| `subscription_plan`, `tenant_subscription` | New, commercially optional. Subscription state must not be used as a substitute for resource-level membership isolation. |
| `business_invitation` | New, scoped to business, intended identity, role/branch grant, expiry and single-use token digest. |
| `platform_auditlog` | New append-only record of privileged platform activity, reason/ticket and tenant identifier. |

## Uniqueness and indexes to review

Existing global uniqueness constraints include product SKU, category name, product serial number, payment method code, supplier name, branch code, history source keys, sale receipt number, and several UUID request keys. For tenant-owned configuration, decide per-business uniqueness, then use a staged replacement. Do not drop a constraint before detecting collisions and defining conflict-resolution policy.

Potential tenant-scoped constraints:

- `UNIQUE (business_id, normalized_sku)` for products, with historical SKU preservation policy.
- `UNIQUE (business_id, normalized_name)` for categories and suppliers.
- `UNIQUE (business_id, code)` for payment categories; provider code unique within a category.
- `UNIQUE (business_id, source_key)` for historical source identities where import key semantics are tenant-local.
- Keep sale receipt identity stable and unique; if receipt sequence is branch-local, `UNIQUE (branch_id, receipt_number)` is sufficient only if receipt format/policy is changed deliberately. Preserve existing receipt numbers.
- Scope idempotency keys to the relevant tenant/actor/resource where semantics require it; continue to reject reuse by a different principal.
- Preserve `UNIQUE (branch_id, product_id)` for stock balance.
- Revisit cashier-shift constraints for multi-business users, for example one open shift per `(business_id, cashier_id)` or `(branch_id, cashier_id)`, based on approved operations.

Add indexes that start with tenant scope for common access paths, for example `(business_id, created_at)`, `(business_id, status)`, `(business_id, branch_id, business_date)`, `(business_id, product_id, business_date)`, and membership lookup `(user_id, business_id, status)`. Validate real query plans before adding redundant indexes.

## Cross-tenant relationship integrity

A foreign key to an existing product does not prove that the product belongs to the receipt's business. A serializer check alone can be bypassed by a future code path. Validate all relationship edges:

- branch ↔ business;
- membership ↔ user/business and branch grant ↔ same business;
- sale ↔ branch/business, day, shift, cashier membership, products and payment methods/providers;
- refund ↔ original sale, refund day/branch and methods/providers;
- stock movement/adjustment/receipt ↔ branch/business and product;
- expense ↔ branch/day/shift and payment method;
- payment total ↔ shift and payment method;
- historical rows ↔ batch/business and mapped product.

Use composite unique keys such as `(business_id, id)` where needed and PostgreSQL composite foreign-key constraints or a documented equivalent to enforce same-tenant relationships. Django model constraints and service validation should mirror those database invariants. Test inserts/updates using cross-tenant IDs directly at API and database boundaries.

## Preserve current financial/inventory semantics

- Keep stock balances branch-specific and keep movement ledgers append-only.
- Keep sale, refund, void, close and correction arithmetic and request idempotency.
- Do not merge stock across branches; consolidated reports aggregate authorized branches without combining their ledger rows.
- Keep the distinction between `Product.cost_price` (used for sale-line cost snapshot per `sales/services.py`) and `Product.average_cost` (updated on receipt in `catalog/costing.py`, explicitly informational). Tenant conversion is not approval to change costing.
- Branch day opening/closing cumulative sales remain independent chains. Business-level reporting can sum branch results; it must not create one cross-branch day chain.
