# 05 — Existing MERIBA data migration strategy

## Safety and scope

This is a plan only. No database was inspected or modified. Do not connect this process to production, run migrations, or use live data for migration tests. All rehearsal and migration tests must use a separate local/staging PostgreSQL database restored from an approved, access-controlled backup.

The migration goal is to create the first tenant, MERIBA, and associate existing records without changing their meaning or identity. Preserve all primary keys, receipt numbers, request keys, snapshots, ledger rows, timestamps, actor references and audit history.

## Required preflight

1. Identify the authoritative production backup/recovery owner, retention policy, restore procedure and maintenance window. Verify restore into isolated staging before any rollout approval.
2. Inventory exact schema/migration state and row counts in the isolated copy. Do not assume production is at the repository migration head.
3. Record per-branch/date stock ledger totals, current stock balances, sale/payment/refund totals, business-day arithmetic and cumulative opening/closing chain, expenses/receipts, audit row count and historical import summaries.
4. Check for duplicate/colliding SKU, category, supplier, payment, branch, serial, history source and receipt identifiers under the proposed tenant uniqueness rules.
5. Establish a signed-off mapping: all current MERIBA branches and their settings, users and roles, live and historical records, and any platform/auth-only audit rows. Do not guess missing ownership.
6. Determine whether writes are paused, feature-flagged or dual-written during rollout. Avoid an unbounded “add fields while old code keeps writing” window unless the bridge code is verified.

## Additive migration sequence

### A. Schema only

- Add `Business` and membership/settings/invitation/platform metadata tables without replacing `accounts.User` or changing the authentication identity.
- Add nullable `business_id` columns to `core.Branch`, tenant-owned catalog/configuration, branch operations, audit/history rows where direct ownership is needed.
- Add new supporting indexes, initially as safely deployable indexes suitable for PostgreSQL and expected table size. For large production tables, choose concurrent index creation and Django migration transaction behavior deliberately.
- Retain all current unique constraints and non-null semantics during the compatibility period.
- Keep database migration dependencies explicit across `core`, `accounts`, `catalog`, `sales`, `finance`, `inventory`, `trading`, and `history`. Create the tenant root before adding dependent foreign keys; add membership only after both existing User and Business tables exist.

### B. Backfill MERIBA ownership

In a data migration using Django historical models (not imported current runtime models):

1. Create one stable MERIBA `Business` row with a fixed migration-controlled ID or a safely discoverable stable natural key. Make the data migration idempotent and document its reverse behavior.
2. Set `business_id` on existing branches, retaining each branch PK and code. `core/migrations/0002_seed_main_branch.py` shows the original Main Branch seed; production may have later branches, so map all existing branches, not only the seeded one.
3. Backfill business-owned configuration: categories/products, suppliers, payment methods/providers. Verify every ProductUnit resolves through its tenant-owned product.
4. Backfill branch-owned rows from their existing branch/day/sale/receipt parent. Verify that every operational row receives exactly one tenant and that all referenced products, payment methods, users and branches map consistently.
5. Attribute existing `BusinessSettings` to the same MERIBA branch/business while splitting branch-specific and tenant-wide fields only according to an approved field mapping.
6. Assign historical Excel batches, source products, historical rows and review decisions to MERIBA. Keep them separate from live stock/sales.
7. Preserve existing audit rows. Since the current product operates as one business, assign tenant-business audit rows to MERIBA; classify platform/auth-only records explicitly rather than dropping or silently exposing them.
8. Create one `BusinessMembership` per existing active/inactive user for MERIBA, mapping the existing global role exactly. Preserve username, password hash, active status, last login and password-change requirement. Do not copy users or reset passwords.
9. Keep audit actor foreign keys and historical usernames even for deactivated users; do not delete accounts.

The migration must not recalculate stock, rewrite financial history, regenerate receipt numbers, modify sale snapshots or turn historical workbook rows into live transactions.

### C. Verify before enforcing

Run a read-only reconciliation on the isolated staging copy and compare against the preflight baseline:

- row counts and stable PK sets per table;
- each branch belongs to MERIBA;
- no tenant-owned row has null/invalid business ownership;
- branch-owned row business agrees with branch business;
- all sale items, receipts, movements, expenses, refunds, payment/provider and employee links are tenant-consistent;
- stock balance equals the original balance and movement arithmetic still holds;
- per-day totals and cumulative sales chain remain unchanged;
- sale/payment/refund/export-visible snapshots and historic import fingerprints remain unchanged;
- audit row count and actor/action/created-at signatures are preserved;
- user count, usernames, password hashes, roles-to-membership mapping and active states are preserved;
- no duplicate values violate proposed tenant-level uniqueness.

Produce a reconciliation report, exception list and explicit business-owner sign-off. Do not “repair” unexplained discrepancies as part of this migration.

### D. Enforce and change API behavior

- Deploy tenant-aware code that can read existing MERIBA-owned records while new data is written with verified ownership.
- Resolve global uniqueness conflicts and choose a deterministic remediation only with owner approval; preserve old keys where they appear on historical records.
- Add same-tenant constraints and make required business FKs `NOT NULL` only after no nulls or invalid references remain.
- Replace global unique constraints with approved tenant-scoped constraints in separate migrations. Use a staged constraint approach (including concurrent index/constraint strategy if needed).
- Deploy membership-aware authorization, then remove old global-role/first-branch behavior when compatibility metrics prove it is no longer needed.

## Rollback and recovery

- Use additive schema and expand/contract releases. Preserve old columns and constraints until the new path is proven.
- Before writes occur under the new model, rollback can disable new code and retain nullable additive columns. After tenant-aware writes begin, rolling back old code is unsafe unless a tested reverse synchronization/compatibility path exists.
- Do not delete the new tenant columns, membership rows or audit data as a “rollback.” Restore from approved backup only under the data recovery plan.
- Take a fresh backup immediately before the production migration window; verify restore readiness first.
- No production deployment/migration is authorized by this document.

## Current migration facts and change risks

- Migrations are per-app under `backend/*/migrations/`; the Main Branch was seeded by `core/migrations/0002_seed_main_branch.py`.
- `backend/tests/conftest.py` currently creates a branch and global payment methods, so tenant schema changes need fixture/data setup updates in tests before migration behavior can be considered validated.
- Existing constraints include `UniqueConstraint(branch, product)` for stock, unique branch/day and one open day per branch, globally unique sale receipt/request keys, and global product/category/payment/supplier identifiers. Audit each before making tenant uniqueness changes.
- Existing FKs use `PROTECT` for much of the financial/stock history. Preserve this protection and avoid destructive table rebuilds or PK changes.
- Migration graph dependencies must be reviewed from actual migration files, not inferred only from app names. No `makemigrations`, `migrate`, or database command was run in this assessment.
