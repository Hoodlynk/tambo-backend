# Android app review — contract fixes needed (2026-09-12)

**Audience:** Kevin. Review of commits `a512435`, `fc5a931`, `8f770c8`
(email verification, terms agreement, protection off-switch) plus the earlier
auth and failed-unlock work. The engineering quality is genuinely good — the
native capture layer especially. Three places talk to a backend that doesn't
exist, though; all three are contract mismatches, and all three are avoidable
from now on: **generate your types from the spec**
([client-generation.md](client-generation.md)) instead of hand-writing them.

## 1. Unverified login: branch on the body, not on an error code

`screens/LoginScreen.tsx` expects a rejected promise with code
`email_unverified` carrying a challenge. The server never sends that. A
correct password with an unproven mailbox is a **200** whose body has
`challenge` and **no** `tokens`:

```
POST /api/v1/auth/login
→ 200 { "user"?, "tokens"? }      // verified account: session issued
→ 200 { "challenge": { ... } }    // unproven mailbox: finish via /auth/otp/verify
→ 401 invalid_credentials         // wrong password OR unknown email
```

As written, the success path runs `persistSession(response)` with
`response.tokens === undefined` and crashes. Fix: after `.unwrap()`, branch on
`'challenge' in response` → navigate to VerifyOtp with intent `register`;
otherwise persist the session. (The generated TS types make this branch
mandatory.)

## 2. `POST /auth/verify-email` — it now exists, with these exact semantics

Your `useEmailVerification` hook called an endpoint that didn't exist (it
404'd). It has now been built to match your flow — you need only confirm the
details:

```
POST /api/v1/auth/verify-email        (Bearer JWT, no body)
→ 200 { "challenge": { purpose: "signup", ... } }   // code emailed
→ 409 email_already_verified                         // your stale-slice case ✓
→ 400 no_email
→ 401 unauthorized / missing_token
→ 429 rate_limited (5/hour)
```

Your `email_already_verified` handling (refetch `/me`, drop the banner) is
exactly right. Note this state is only reachable for **legacy** accounts —
new signups are verified before their first session exists.

## 3. Terms acceptance must be recorded on the server

`src/utils/terms.ts` stores acceptance in AsyncStorage with the comment
"there is no server record of it yet". There is —
[legal-api.md](legal-api.md) — and it matters: **the server refuses device
enrolment** (`403 legal_acceptance_required`) until the account has accepted
the current version of BOTH documents. What to change in the TermsSheet flow:

1. `GET /api/v1/legal` (public) → the two documents `{ doc, version, url }`.
   Render from `url` (don't hardcode it) and show **both** terms AND privacy —
   the sheet currently shows terms only.
2. Your scroll-to-end gating is exactly what the product rule requires — keep
   it, and on accept call `POST /api/v1/legal/accept` once per document with
   `{ doc, version, scrolledToEnd: true }` (the version you displayed).
3. After login, `GET /api/v1/legal/status` — any `upToDate: false` ⇒ re-show
   that document's sheet. This replaces the per-device AsyncStorage flag
   (server record survives reinstalls and covers version bumps).

## Also now available

- `/api/v1/auth/*` is the canonical mount (your `/api/auth/*` calls keep
  working as a legacy alias).
- `GET /api/openapi.json` — the whole contract, typed. `npm run client:ts` in
  the backend repo emits `clients/typescript/tambo-api.d.ts`; consume it via
  `openapi-fetch` and delete `src/redux/types.ts`'s hand-written shapes.

## Next milestone (unchanged)

Device enrolment + the evidence uploader
([f1-client-contract.md](f1-client-contract.md)): your captured events still
never leave the phone, which is the product's whole reason to exist. The
contract cue for the trail: an ingest response carrying
`episodeId`/`episodeOpened: true` starts the TRAIL_POINT fan-out.
