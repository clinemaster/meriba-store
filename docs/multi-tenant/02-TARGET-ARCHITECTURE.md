# 02 — Target multi-tenant architecture

## Decision

Start with one Django application and one PostgreSQL database using a shared-schema, shared-table tenant model. This fits the current monolith and the initial 100+ business target without introducing a database-per-tenant operations burden. Tenant ownership must be explicit, indexed and checked in application code. A larger scale target is not a reason to weaken isolation; measure query, storage and operational limits before considering sharding or tenant-specific databases.

Keep the existing apps and services. Add business ownership and membership authorization to them rather than rebuilding POS, inventory, closing, reports or the frontend.

## Proposed entity model

```text
PlatformAdministrator ──1:1── User (existing global login identity)
PlatformAdministrator ──< PlatformAuditLog
SubscriptionPlan ──< TenantSubscription >── Business

Business ──< BusinessMembership >── User
Business ──< Branch ──< BranchMembership >── BusinessMembership [optional restriction]
Business ──1:1── BusinessSettings
Business ──< BusinessInvitation
Branch ──1:1── BranchSettings

Business ──< Category ──< Product ──< ProductUnit
Business ──< Supplier
Business ──< PaymentMethod ──< PaymentProvider
Branch ──< StockBalance / InventoryMovement / BusinessDay / Sales / Receipts / Expenses
Business ──< AuditLog / historical-import records
```

In the final schema, each tenant-owned row should have an explicit `business_id` where it provides an isolation boundary, access path, or RLS key. Branch-owned operational records must agree with the business that owns the referenced branch. Product and payment configuration ownership must agree with the tenant of the receiving transaction. Redundant tenant IDs require consistency constraints (composite foreign keys or equivalent PostgreSQL constraints/triggers) as well as service validation; they must never be treated as independent, caller-controlled values.

## Entity responsibilities

### Platform

- **`PlatformAdministrator`**: a profile/authorization record linked one-to-one to the existing `accounts.User`; do not create a second platform login identity. Platform access must not imply membership in every tenant.
- **`SubscriptionPlan`**: optional commercial catalog (plan code, name, limits/features, active/effective dates). Keep billing rules outside POS and inventory services.
- **`TenantSubscription`**: business, plan, status, effective period, external billing reference if one is later approved, and immutable/audited state changes. A subscription is not tenant authorization by itself.
- **`PlatformAuditLog`**: append-only record of platform staff actions, including actor, tenant, reason/ticket, action, timestamp and before/after summary. Do not copy customer transaction detail into platform logs.

### Business

- **`Business`** (tenant): stable ID, display/legal/trading names, unique normalized slug or tenant code, status (`PENDING`, `ACTIVE`, `SUSPENDED`, `CLOSED`), created/updated timestamps and onboarding metadata. Status transitions need audit history.
- **`BusinessMembership`**: unique `(business, user)` relationship, status, role and membership-level permissions. Initial roles should map existing `OWNER`, `ACCOUNTANT`, `CASHIER`; future roles must be explicit, not implicit superuser flags. A person may have multiple memberships and different roles.
- **`BusinessSettings`**: one per business for currency (default `TZS`), locale/time-zone defaults, legal/trading identity, and business-wide preferences. Keep compatibility with existing receipt and sales settings; do not move a setting to business level if it varies by branch.
- **`BusinessInvitation`**: business, normalized email/identity, intended role/branch scope, secure hashed single-use token, inviter, expiry and accepted/revoked timestamps. Invitation acceptance must bind the intended identity and create a membership transactionally.
- **`TenantStatus`**: prefer a status field with constrained choices and audited transitions on `Business`, rather than a duplicate state entity unless a status-history table is required.

### Branch

- **Existing `core.Branch`**: add a required `business` FK after backfill. Keep its stable ID and current branch code where possible; change globally unique code constraints only after collision analysis.
- **`BranchMembership`** (or a branch-grant table linked to `BusinessMembership`): explicit allowed branch set for a member. Define whether an empty grant means “all branches” or “none”; recommended: `all_branches` explicit boolean, and explicit rows for restricted members. Owners need access to all branches in their business.
- **`BranchSettings`**: split only branch-varying preferences from the existing `core.BusinessSettings`, such as receipt header/footer, cash variance tolerance, local business day/timezone, and branch go-live/opening figures. Preserve a clear migration mapping from today's one-to-one branch settings.
- Branch activation/deactivation must not delete financial/inventory history. A branch cannot be hard-deleted when referenced.

## Active business and branch context

1. After authentication, provide a membership list from `/api/v1/auth/me/` or a dedicated context endpoint.
2. The user chooses an active business and, where needed, a branch through an authenticated context-switch endpoint. Store the selected IDs in the server-side session (or equivalent signed server-validated context); treat any path, header or body IDs as a selector only.
3. On every business-scoped request, resolve the selected business and active membership from the authenticated user. Resolve the branch only if it belongs to that business and the membership is allowed to access it. Re-check status and authorization; do not trust a stale session.
4. Require branch selection for branch operations. Business-level views may use an explicit “all authorized branches” scope. Never silently select the first active business or branch.
5. Missing context is a controlled `400`/`409`; unauthorized or nonexistent tenant/branch identifiers should not disclose existence (use a consistent `404` policy where appropriate).
6. Services accept a verified context or explicit authorized business/branch objects. They do not call a global first-branch helper.

This fits the existing session-cookie, CSRF-protected `frontend/src/lib/api.ts` client and `frontend/src/lib/auth.tsx` auth context while making authorization server-side.

## Tenant ownership of existing domain data

- **Business-owned shared configuration:** categories, products, product units, suppliers, payment methods/providers, and business-level settings.
- **Branch-owned operations:** stock balances, inventory movements/adjustments/counts/alerts, business days, shifts, sales, refunds, expenses, receipts and receipt imports.
- **Tenant attribution and visibility:** audit logs, historical Excel imports/reviews, subscription records, invitations.
- **Derived/read-only reports:** always run from the authorized tenant/branch scope; do not persist a tenantless aggregate.
- **Customers:** there is no existing customer entity or workflow. If approved later, add a business-owned customer model; do not add customer data to historical sales as a side effect of this migration.

## API shape and compatibility

Keep `/api/v1/` and existing business operations. Add endpoints for tenant registration/onboarding, membership/invitation management, branch management, authorized branch listing, and context switching. Existing API resources should use the validated request context and tenant-filtered querysets. A tenant ID in a URL can improve clarity but cannot replace membership validation.

During rollout, maintain a compatibility mode for the existing MERIBA operator path: a user with exactly one permitted business/branch may have that context selected explicitly at login/onboarding. Once a user has multiple choices, the API must require selection. Avoid an implicit “first business” fallback.

## Scale and isolation posture

At 100 to thousands of tenants, shared PostgreSQL tables are a reasonable first deployment, provided all tenant-owned lookups are indexed (typically `(business_id, …)` or `(business_id, branch_id, …)`), high-cardinality tables are paginated, and slow reports are measured. Add partitioning or read replicas only from observed bottlenecks; row partitioning does not itself enforce authorization.

RLS is evaluated as defense in depth in `04-TENANT-ISOLATION-SECURITY.md`. Application-level authorization remains mandatory.
