# ADR 0007 — Bounded M1 auth transport and onboarding

Operator explicitly authorized continuation after P1-06/P1-07, limited to M1. P1-08 A owns HTTP adapters, P1-09 B owns email verification lifecycle, P1-10 E owns production auth pages. Existing server/controlled UI acceptance stays intact; core ledger/need transitions and full M1 remain separate gates. No worker, AI, import, Telegram or reporting expansion.

Preserve credential sign-up enabled as in ADR 0006; registration creates an account and no tenant membership. No public organization creation/admin endpoint is exposed by this wave. Invitation acceptance remains bound to matching verified recipient and the current library policy. Email verification is explicitly requested, expiring and single-use; it sets emailVerified for the intended account without granting tenant access. No global verified-email sign-in gate is added. Account creation/verification screens must explain that organization membership still needs an invitation. Demo credentials/provisioning remain a later B-only scoped task, not ordinary seed behavior.

## Frozen HTTP boundary

Only explicit handlers, no unrestricted Better Auth catch-all. All JSON responses are canonical Result: successful mutation is `{ok:true}` (void value omitted in JSON); GET organizations returns `{ok:true,value:AuthOrganizationChoices}`. Failures contain canonical safe ApiError. Status mapping follows CONTRACTS (401/403/404/422/409/429/503); success 200. Never return SDK user/session/token/password models. Do not reflect raw SDK errors. Use no-store on every auth response, including errors. Per-call headers preserve distinct Set-Cookie values on success and subsequent failure. Treat HTTP/SDK mapping as transport, no duplicate auth policy.

| Method/path                         | Strict body or result           |
| ----------------------------------- | ------------------------------- |
| POST /api/auth/sign-in              | AuthSignInCommand               |
| POST /api/auth/sign-up              | AuthSignUpCommand               |
| POST /api/auth/sign-out             | Empty object                    |
| POST /api/auth/reset/request        | AuthResetRequest                |
| POST /api/auth/reset/confirm        | AuthResetConfirm                |
| POST /api/auth/verification/request | AuthVerificationRequest         |
| POST /api/auth/verification/confirm | AuthVerificationConfirm         |
| POST /api/auth/invitations/accept   | AuthInvitationAcceptance        |
| POST /api/auth/organizations/select | AuthOrganizationSelection       |
| GET /api/auth/organizations         | Result<AuthOrganizationChoices> |

Mutations require application/json, bounded body (16 KiB), same-origin browser Origin matching configured APP_URL (missing/foreign/null Origin denied), and library CSRF/origin defenses remain enabled. Controlled non-browser tests supply Origin. Do not trust forwarded host/origin headers or client user IDs. No client redirect/callback fields: A derives same-origin reset destination /reset-password and verification destination /verify-email. Navigation uses fixed same-origin paths, no returnTo query redirects. Cookies remain library-managed; app code never fabricates session cookies. Sign-in/sign-up preserve SDK response headers and sanitize status failures. Public reset/verification request acknowledgement stays opaque under unknown-account and recipient-specific mail failures; global missing mail config may fail uniformly before lookup.

GET organizations composes verified session with live memberships. currentOrganizationId is a display-only session selection, retained only if it matches a current option, otherwise null. Missing/invalid session returns UNAUTHENTICATED. Removed membership is never authority. Organization selection uses accepted helper live checks. No business authorization comes from this projection.

A adapters are injectable for controlled tests; production missing mail is explicit unavailable, never a recording mailer. SMTP transport is deferred and no new dependency/environment setting is implied. B adds optional sendEmailVerification callback to the existing server-owned AuthMailCallbacks; payload is bounded to intended recipient/name and verification URL/token (derived from installed library). It logs nothing. B exposes safe requestEmailVerification/confirmEmailVerification on createSessionResolver with canonical commands, correlationId and optional per-call responseHeaders; no shared Result change. Callback destinations are APP_URL only. Both methods resolve safe Results on dependency failure; confirmation does not create membership or an unrequested session.

E owns /sign-in, /sign-up, /reset-password, /verify-email, /invitations/[invitationId], /account. /reset-password without token shows request form; /verify-email without token shows request form. Supplied token/ID comes from route input, is never logged/stored, and grants no authority. /account uses GET choices plus POST select/sign-out; unauthenticated/empty/error/loading states are explicit, no fictional success. E validates canonical response shapes and maps callbacks to Result<void>. E tests fetch through controlled browser routes until A endpoints are accepted. The existing /dev/auth preview stays simulated and production-hidden. These screens do not send SMTP themselves.
