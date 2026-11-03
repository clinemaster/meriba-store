# 04 — Tenant isolation and security design

## Security objective

For every tenant-scoped request, resolve the authenticated identity, active membership, business and (where relevant) branch on the server. No user-controlled tenant, branch, product, employee, payment, or export identifier is authorization. A missing or invalid context fails closed.

## Request authorization flow

1. Authenticate with the existing Django session and CSRF controls.
2. Resolve a requested active business against an active `BusinessMembership` for `request.user`. Reject inactive, suspended, expired or revoked membership.
3. Resolve a requested branch against that business and the membership's branch policy. For all-branch reports, use the authorized set, not every branch in the database.
4. Attach an immutable verified context to the DRF request (or pass it explicitly). Resolve it after DRF authentication; middleware should not infer authorization from a raw header.
5. Scope the initial queryset before looking up detail IDs. Use scoped `get_queryset()`/service APIs rather than `Model.objects.get(pk=...)`.
6. Validate every nested and writable foreign key against the same business and the permitted branch set.
7. Record tenant, branch, actor and request ID on audit events. Do not log secrets or payment credentials.

An ID outside the user's scope should return the same not-found behavior as an unknown ID where existence disclosure matters. Do not silently switch to a default tenant.

## Mandatory application-level controls

- **Querysets:** apply business scope to list, retrieve, update, delete, custom actions, autocomplete, counts and pagination. Review raw `.objects.all()` and broad `.filter()` calls across all apps, including serializers, admin/management commands and report helper functions.
- **Writes:** set tenant/branch from verified context on the server; ignore or reject tenant IDs in request bodies. Restrict serializer relation querysets to tenant-owned objects and permitted branches.
- **Object-level access:** scope the object lookup before mutations such as void, refund, adjustment, review, provider correction, password reset and invitation acceptance.
- **Relationships:** reject foreign-key combinations crossing tenants, even if each referenced ID exists. Revalidate under transaction where values can change concurrently.
- **Reports and exports:** tenant-filter before aggregation, joins, totals, row counts, dropdown options, CSV/Excel generation and audit logging. Test downloaded contents, not only endpoint status.
- **Business context:** active context is selected by the user but authorized by the server on every request. Session context is a convenience, not a grant. Re-evaluate when membership, branch access or tenant status changes.
- **Caching:** any future cache key containing tenant data must include tenant and branch scope. Current locmem cache is not an authorization layer; clear or namespace tenant data when adding cache entries.
- **Pagination/search:** limit page sizes and ensure count queries/search endpoints are scoped before counting or searching.
- **Management commands:** require explicit `--business`/tenant context for tenant-specific actions, validate it, and log changes. No hidden first-branch fallback.
- **Audit:** tenant audit feeds only show that tenant. Platform actions go to a separate platform audit stream and require actor, ticket/reason and tenant target.

## Platform support access

Do not grant platform administrators implicit membership in every tenant or unrestricted read access to transaction data. Start with metadata-only support tools (tenant status, health, subscription, migration/version state). For any exceptional tenant-data access:

- require a separate, strongly authenticated platform identity/profile and MFA;
- use a time-limited, tenant-specific support grant and a documented support reason/ticket;
- require approval for sensitive exports or financial record access;
- log every read, export and write to `PlatformAuditLog`;
- expose only the minimum fields needed; mask personal/payment references where possible;
- provide a visible support-access indicator and revoke/expire access automatically;
- prohibit impersonation that creates an untraceable tenant-user session.

The present application does not implement a platform-admin role or staff console; these are new capabilities, not assumed current features.

## PostgreSQL Row-Level Security evaluation

RLS is a useful additional defense for tenant-owned tables, but it does not replace query scoping or application authorization. It is not a first migration step because this code uses Django ORM autocommit/request services and PostgreSQL connection reuse (`CONN_MAX_AGE=60`).

If adopted after application scoping:

1. Set a tenant context using transaction-local settings (for example `SET LOCAL`) inside a transaction; never use a connection-persistent tenant variable that can leak through pooling/reuse.
2. Ensure every protected query—including background/management paths—runs with a verified tenant context and fails closed if absent.
3. Restrict the runtime database role: it must not own protected tables or have `BYPASSRLS`; table owners/superusers can bypass normal RLS policies.
4. Cover reads and writes with policies, including inserts/updates and branch constraints; test invalid `WITH CHECK` rows.
5. Account for nested transactions, streaming CSV/Excel responses, request transactions, worker connection reuse and error cleanup.
6. Test against the same PostgreSQL role and connection-pool behavior as production, including a request after a different-tenant request on the same connection.

RLS rollout needs an explicit implementation design and isolated staging verification. Do not activate it by migration during this assessment phase.

## Background and offline work

No background worker or offline POS synchronization was found. If introduced later:

- enqueue a stable business ID and permitted branch ID, not only a user-provided tenant slug;
- resolve and revalidate tenant status, actor/service identity and authorization at execution time;
- use tenant-bearing idempotency keys and tenant-scoped data access;
- make retries safe and ensure jobs cannot inherit a prior request's thread-local context;
- include tenant scope in object storage keys and signed download URLs for generated exports;
- retain export ownership, expiry and access audit history.

An offline POS feature would require a separately designed trusted device identity, signed/expiring credentials, tenant/branch-bound sale queue, replay protection, idempotent sync, conflict handling and revocation. None exists in the current frontend/API; browser local storage is used for preferences only.

## Threat-driven automated tests

Use at least two businesses, two branches per business, a shared user with distinct roles, and isolated users. Test:

1. Tenant A cannot list, retrieve, mutate, void, refund, adjust or export tenant B records by changing IDs, query filters, body fields, URL paths or headers.
2. A user with membership in both businesses can switch contexts but receives the role/branch permissions of the selected membership only.
3. A user restricted to one branch cannot access a sibling branch via direct IDs, reports, payment filters or dropdown options.
4. Cross-tenant nested references (product, method/provider, supplier, cashier, shift/day, receipt) are rejected and create no partial records.
5. Revoked membership, inactive branch and suspended business deny access immediately, including stale sessions.
6. Reports, CSV/Excel exports, totals, pagination counts, payment reconciliation and audit history contain only authorized tenant/branch rows.
7. A completed sale updates only its tenant/branch stock and day; existing transaction atomicity and immutability remain true.
8. Tenant-specific unique constraints allow legitimate duplicate SKU/category names in different businesses while rejecting duplicates within one.
9. Platform support actions require valid reason/grant, are audited, and cannot access unrelated tenants.
10. If RLS is introduced, run direct ORM/SQL tests with the production-like restricted DB role and reused connections.

Use PostgreSQL-backed isolated test databases; do not use production for these tests.
