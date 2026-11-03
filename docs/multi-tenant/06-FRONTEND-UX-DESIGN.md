# 06 — Frontend UX design

## Preserve the existing product

The current frontend is a Next.js App Router application with shared `AppShell`, role-aware `SidebarNav`, `ui.tsx` controls, reusable tables/modals/forms, and a single `frontend/src/lib/api.ts` API client. Preserve these components, the gold/navy MERIBA visual language, touch-sized controls, mobile sidebar, accessibility patterns and plain-language errors. Add tenant concepts around existing screens rather than replacing POS and back office.

The current `AuthProvider` (`frontend/src/lib/auth.tsx`) stores one user; `types.ts` defines one global role; `nav.ts` and `AppShell.tsx` gate the sidebar by that role. These become membership- and context-aware. The backend remains the source of truth for permissions.

## Proposed operator navigation

### Shared application header

- Business switcher showing business name, with only memberships the signed-in user can access.
- Branch switcher showing only assigned active branches; allow “All branches” only on explicitly business-wide views and with an authorized membership.
- Active context displayed visibly near the business name so staff can detect the wrong shop before selling.
- Role label from the active business membership, not a global user role.
- Switching context clears tenant-dependent cached screen state, reloads the current route under the new scope, and handles a stale/revoked membership with a clear message.

Keep the header responsive and usable on phones. Do not put an unvalidated tenant ID in local storage and treat it as authority.

### Registration and onboarding

Suggested screens/routes, consistent with the existing App Router organization:

- `/register`: create global identity and initial business, with verified email/phone strategy still to be decided.
- `/onboarding/business`: business/trading name, region/time zone defaults, currency default `TZS`.
- `/onboarding/branch`: create first branch; main branch is required to complete onboarding.
- `/onboarding/setup`: reuse product setup, opening physical stock count, payment configuration, cashier invitation and go-live patterns. Preserve existing owner approval gates.
- `/businesses`: list/switch memberships and create another business where account policy allows.

Avoid asking for subscription billing details in the core operational onboarding until commercial requirements and provider are approved.

### Business and branch administration

- `/settings/business`: business name, legal details, currency and receipt defaults.
- `/branches`: list with active/inactive status, location and staff coverage.
- `/branches/new` and `/branches/[id]`: create/edit branch settings, deactivation confirmation, opening/setup checklist. Never hard-delete an operational branch.
- Branch creation should explain that stock, day closing and financial reporting start independently. A new branch needs its own opening count and go-live approval.

### Staff and invitations

- `/team`: list members, business role, invitation state and allowed branches.
- Invite flow: identity, role, branch scope, expiry preview; do not display or email permanent passwords.
- Role editing/removal confirms impact on active sessions/shifts and ensures an active Owner remains for the business.
- Reuse existing modal, form, alert and table components; adapt copy to plain language for liquor-store operators.

### Reporting

- Make branch scope explicit on report pages: selected branch or “All authorized branches”.
- For consolidated reports, label the total as business-wide and preserve branch drill-down. Do not combine separate business-day cumulative balances into one apparent branch balance.
- Apply tenant/branch filters to data, totals, exports and filter option lists, not only the visible table.

## Platform administration

A separate, staff-only platform console should not appear in a tenant owner's navigation. Initial console should focus on business status, subscription state, onboarding and system health. Sensitive customer-data access must require a time-bound support grant, reason/ticket and conspicuous support mode; audit each read/export/write. Keep platform administration separate from tenant membership and business-owner operations.

## Subscription UX

Commercial subscription management can later add plan/status/renewal/limit views. In-product billing, payment provider integration, automated suspension and usage quotas are optional commercial features, not prerequisites for tenant isolation. Any suspension UX must state the effect and preserve read-only/export/recovery policy as approved; never delete tenant records due to subscription state.

## API/client behavior

- Extend `User`/auth response types with membership list, active membership role and allowed branches; avoid trusting client-side role checks.
- Add an API method for context selection and an endpoint to fetch current business/branch and memberships.
- Let `api.ts` continue same-origin requests, CSRF handling, no-store behavior and API errors. Context headers/session are selection only; backend validates them every request.
- Ensure failed context switches do not leave mixed-tenant data on screen. Clear per-tenant query state, reload, and surface authorization errors explicitly.
- Include selected context in client cache/query keys if a query cache is introduced; do not persist transaction data in the browser as an offline mechanism.

## TZS and locale

Keep `TZS` as the default business currency and Tanzania time zone behavior aligned with existing `BUSINESS_TIMEZONE` (`Africa/Dar_es_Salaam`). Continue sending decimal values as strings and use existing money helpers (`frontend/src/lib/money.ts`). Currency should be configurable per business only after report/export formatting and accounting semantics are approved. Do not mix currency totals in consolidated reporting.

## Frontend acceptance tests

- Business/branch selectors show only authorized options and are keyboard/touch accessible.
- Switching business updates membership role, menu, settings and all displayed data without stale rows.
- Branch-restricted staff cannot select unauthorized branches; server denial is shown in a clear way.
- Onboarding creates a first branch and returns the user to the existing setup/go-live workflow.
- Invite, accept, role change and revocation states are clear and safely recoverable.
- Existing sales/day/closing flows remain usable on desktop and mobile under explicit tenant context.
- Business-wide reports label scope and export the same authorized dataset shown by the selected filters.
