# Legal documents API — T&C and privacy policy acceptance

**Audience:** the Android engineer.
**What it is:** the backend is the system of record for *which version* of the
Terms & Conditions and Privacy Policy exists, *where* the content lives (the
website), and *who accepted what, when*. The app renders the documents and
gates the accept button; the server records and audits.

All code: [`src/services/legal.service.ts`](../src/services/legal.service.ts),
[`src/routes/v1/legal.routes.ts`](../src/routes/v1/legal.routes.ts),
[`src/models/legalAcceptance.model.ts`](../src/models/legalAcceptance.model.ts).
Tests: [`tests/legal.test.ts`](../tests/legal.test.ts).

---

## The product rule this implements

At sign-in/sign-up the user must be shown the T&C **and** the Privacy Policy
clearly, in-app (modal/sheet), with the content sourced from the website. The
accept button stays **disabled until the user has scrolled to the end** of the
document. Acceptance is recorded server-side under the user's profile. When a
document's version changes, every user is re-prompted on next login.

## The app flow

1. **Before/at login** — `GET /api/v1/legal` (public, no auth):

   ```json
   { "documents": [
       { "doc": "terms",   "version": "1.0", "url": "https://tambo-app.com/terms" },
       { "doc": "privacy", "version": "1.0", "url": "https://tambo-app.com/privacy" }
   ] }
   ```

   Render each document in-app from its `url` (WebView or fetched content).
   Keep the `version` you displayed — you send it back on accept.

2. **After login** — `GET /api/v1/legal/status` (Bearer JWT):

   ```json
   { "documents": [
       { "doc": "terms", "version": "1.0", "url": "...",
         "acceptedVersion": "1.0", "acceptedAt": "2026-09-09T07:00:00.000Z",
         "upToDate": true },
       { "doc": "privacy", "version": "1.0", "url": "...",
         "acceptedVersion": null, "acceptedAt": null, "upToDate": false }
   ] }
   ```

   Any document with `upToDate: false` ⇒ show its modal before letting the
   user continue. (`acceptedVersion` non-null but `upToDate: false` means they
   accepted an *older* version — the document changed, re-prompt.)

3. **On accept** — `POST /api/v1/legal/accept` (Bearer JWT), one call per
   document:

   ```json
   { "doc": "terms", "version": "1.0", "scrolledToEnd": true }
   ```

   Returns the updated status object for that document. The server stores the
   acceptance (user, doc, version, URL shown, time, user agent, IP) as an
   immutable audit row.

## Rules the server enforces

| Situation | Response |
|---|---|
| `scrolledToEnd` anything but `true` | `400 validation_error` — the endpoint refuses an acceptance the client says wasn't scroll-gated. Keep the button disabled until the scroll hits bottom. |
| `version` ≠ the server's current version | `409 stale_legal_version` — your cached modal is out of date. Re-fetch `GET /api/v1/legal`, re-present, re-accept. |
| Re-accepting an already-accepted version | `200` — idempotent, safe to retry. |
| No/invalid session | `401` — acceptance must be attributable to a user. |

## The backend gate (decided 2026-09-09)

Acceptance is not only recorded — **device enrolment is gated on it**:
`POST /api/v1/devices` returns `403` with code `legal_acceptance_required`
until the user has accepted the **current** version of **both** documents.
So the app must complete both accepts before offering enrolment.

**Exception (owner decision 2026-11-21):** builds that send no
`X-Client-Platform` header are exempt from this gate while
`LEGACY_CLIENT_LEGAL_EXEMPT=true` (the default). The build on Google Play shows
its own terms sheet and stores the answer on the phone, but never calls
`/legal/accept`, so strict gating would stop every new or re-enrolling install
from sending evidence. Each exempt enrolment is logged. Any client that sends the
header is fully gated. The exemption is switched off, and this paragraph
deleted, once the update that records acceptance is the minimum version
([deploy.md](deploy.md)).

The gate deliberately covers only the action that *starts* data collection.
Managing an existing device (list, activity, mark-stolen, token rotation) is
never gated — a T&C version bump must re-prompt users, not brick an
already-protected phone mid-theft. Middleware:
[`src/middlewares/legalGate.middleware.ts`](../src/middlewares/legalGate.middleware.ts).

## Versioning (ops)

The live documents are `https://tambo-app.com/terms` and
`https://tambo-app.com/privacy` (both state **Version 1.0** on-page, matching
the server default). Versions and URLs are env-configured on the server:
`TERMS_VERSION`, `TERMS_URL`, `PRIVACY_VERSION`, `PRIVACY_URL` (defaults in
[`src/config/config.ts`](../src/config/config.ts)). When a document changes,
update the page's stated version AND the env var together — bumping the env
version is the whole re-consent mechanism: every user's `upToDate` flips to
`false` and the app re-prompts at next login. Old acceptance rows are kept
forever — they are the audit trail.
