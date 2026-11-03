# 08 — Risks and open decisions

## Highest risks

| Risk | Why it is present in MERIBA | Mitigation / gate |
|---|---|---|
| Cross-tenant data exposure | `get_branch()` returns the first active branch; global user roles; some products/users/configuration/report queries are not tenant-filtered. | Tenant context validated against active membership on every endpoint; queryset-first scoping; cross-tenant tests; no silent defaults. |
| Cross-tenant references on writes | Serializers currently accept global `Product`, `Supplier`, `PaymentMethod`, `PaymentProvider` querysets. | Tenant-filter relation querysets plus service checks and same-tenant database constraints. |
| Existing records assigned incorrectly | There is no current tenant FK; branch is the best key for many operations but not global catalog, authentication or all audit/history rows. | Reconcile every table on an isolated restored copy and get signed-off mapping before backfill/enforcement. |
| Global uniqueness collision | SKU/name/code/source keys are globally unique today; businesses may want identical values. | Decide tenant-scoped uniqueness and collision policy before dropping constraints. Preserve old IDs and externally visible receipt values. |
| Role conversion can remove access | Current Owner rule guarantees one global active Owner, not one Owner per business. | Backfill one membership per existing user and preserve roles; enforce at least one active owner per tenant transactionally. |
| Session context becomes stale | Membership/branch status can change while a session remains active. | Revalidate every request, revoke/invalidate context on membership changes, fail closed. |
| Report/export leakage | Report helpers and payment filters mix branch-scoped and unscoped queries. | Review every aggregate, option list and export builder; test generated file contents and counts. |
| Data inconsistency due to duplicated tenant IDs | Explicit tenant FK alongside branch/product FK can disagree. | Database composite FK/check/trigger strategy plus serializer/service validation; do not use redundant columns without invariant enforcement. |
| Costing regression | `average_cost` exists but current sale cost snapshot uses `cost_price`; docs/older comments may differ. | Preserve current runtime behavior. Resolve documentation discrepancy separately before any costing change. |
| Migration lock/downtime | Existing financial tables may be large and unique indexes may need replacement. Actual production size/schema state not inspected. | Staged nullable columns, bounded backfill, concurrent index strategy where appropriate, backup/restore rehearsal and approved maintenance plan. |
| Platform staff overreach | Platform-admin model/console does not exist. | Separate platform profile, least privilege, time-limited support access and independent audit; no default tenant data browsing. |
| Future async/offline leakage | No worker or offline POS exists today. Future execution can lose request context or replay another tenant's records. | Design tenant-bound job/device credentials and idempotent sync before introducing such features. |
| Commercial feature coupling | Subscription models, billing and suspension policy do not exist. | Keep optional subscription lifecycle separate from tenant isolation and record retention. |

## Decisions required before implementation

### Identity, roles and membership

1. Can one person use the same login for several businesses? Recommended: yes, retain globally unique username/email identity and assign one membership per business.
2. Are current Owner/Accountant/Cashier roles sufficient initially? Recommended: map them as tenant membership roles, with capabilities centralized in server-side permissions rather than adding a broad custom-permission system prematurely.
3. Can each business have multiple Owners? Recommended: yes, with a per-business last-owner safeguard.
4. May an Accountant access every branch in their business by default? Recommended: choose an explicit policy; avoid ambiguous “empty branch list means all” behavior.
5. What verifies registration/invitations (email, phone, owner approval), and can a user change their login identity?

### Tenant and branch model

6. What business identity fields are required (legal name, trading name, registration/TIN/licence details, address/contact)? Collect only fields the product actually needs.
7. Is one business allowed multiple currencies/time zones? Current default is TZS and `Africa/Dar_es_Salaam`; recommended one currency per business for an initial version.
8. Which settings belong to a whole business versus a branch? Specifically decide currency, receipt header/footer, cash tolerance, time zone, opening cumulative sales, and go-live status.
9. May a branch be deactivated with open shifts, unclosed days, stock, or pending imports? Define a closure checklist; never delete referenced records.
10. Are products/prices/catalog shared across all branches of one business? Recommended: yes, retain current product model and branch-level stock; decide whether branch-specific prices are needed later.
11. Can product/SKU/category/provider names repeat across branches of one business, or are they business-wide? Current catalog is global; proposed model is business-wide.
12. What is the approved cross-branch stock-transfer workflow, valuation basis, approvals, in-transit accounting, and treatment of lost/damaged transfer goods? No transfer model currently exists. Do not implement transfer by editing balances.
13. Should a cashier be allowed simultaneous shifts in multiple branches/businesses? Current uniqueness prevents one user from multiple open shifts globally.

### Data, reports and business rules

14. Confirm that all existing branches, global products, payment methods, suppliers, users, audit rows and history belong to the initial MERIBA tenant. Any exceptions must be mapped.
15. Should tenant admins be able to export all tenant data and request deletion/closure? Define retention, audit/legal records, and backups before commercial onboarding.
16. Confirm the current costing rule: `sales/services.py` snapshots `Product.cost_price`; `catalog/costing.py` maintains weighted average for information. The tenant conversion should not change either.
17. For tenant-wide reporting, should cumulative monetary sales be presented as branch subtotals only? Recommended: do not present one consolidated opening/closing cumulative balance because each branch has its own chain.
18. Are customers, credit sales, taxes, loyalty, or invoices in scope? None were found in current code. Each introduces separate data/permission and accounting requirements.

### Platform and commercial policy

19. Who may be a platform administrator, and what MFA/support approval is required?
20. What customer data can support staff see, for how long, and with what ticket/approval?
21. Are subscriptions in scope for the first SaaS pilot? If yes, decide provider, plan limits, trials, grace periods, suspension behavior, receipts/tax and renewal handling.
22. What is tenant data export, retention and closure/deletion policy? Suspension must not silently erase records.
23. Is PostgreSQL RLS required at initial launch or a later defense-in-depth phase? Recommended: first establish complete application isolation and tests, then evaluate RLS with restricted DB roles and connection reuse.

## Approval gate

No Phase 2 implementation, database migration, production configuration change, deployment, dependency installation or production-data operation has been started. Approval should identify the chosen decisions above and authorize a bounded implementation scope. Once approved, begin with the Phase 1 foundation work package in `07-PHASED-IMPLEMENTATION-PLAN.md`; do not infer approval for later production migrations or commercial features.
