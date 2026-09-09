# Android guide — building the OTP + email flows

**Audience:** the Android engineer.
**Scope:** every flow where the app and the backend's email/OTP machinery
touch: register, login, password change, email change, password reset, and
the emails the app should teach users to expect. Wire shapes below are the
live contract (source: [`src/routes/auth.routes.ts`](../src/routes/auth.routes.ts),
[`src/controllers/auth.controller.ts`](../src/controllers/auth.controller.ts)).

Base path: `/api/auth`. All bodies are JSON. Authenticated calls send
`Authorization: Bearer <accessToken>`.

---

## 0. The mental model

There are two response envelopes, and every auth flow ends in one of them:

- **Session envelope** — `{ "user": {...}, "tokens": { "accessToken", "refreshToken" } }`.
  You are signed in. Store the tokens (Keystore-wrapped).
- **Challenge envelope** — `{ "challenge": { "challengeId", "purpose", "expiresInMinutes" } }`.
  The backend has emailed a 6-digit code and is waiting. Your next move is
  always `POST /api/auth/otp/verify`, which — on success — returns a **session
  envelope** (a *fresh* session: replace your stored tokens with it).

OTP mechanics (server-enforced, current defaults):

| Rule | Value |
|---|---|
| Code | 6 digits, crypto-random |
| Lifetime | 10 minutes (`expiresInMinutes` tells you) |
| Wrong-guess budget | 5 per challenge, then the challenge burns |
| Resend cooldown | 60 s; resending **rotates** the code (old one dies) and does NOT extend expiry or reset the budget |
| One live challenge | Starting a new challenge for the same purpose burns the previous one |

## 1. Register — no OTP today

```
POST /api/auth/register
{ "name": "Dwallo Elias", "email": "user@example.com", "password": "..." }
→ 201 { user, tokens }          // session envelope, signed in immediately
→ 409 email_taken
```

> **Flagged gap (not yet decided):** the server currently marks the email
> verified at registration without proving the mailbox — no signup OTP is
> sent, even though the OTP machine supports a `signup` purpose. If product
> decides registration must be OTP-gated, this contract will change to return
> a challenge envelope here. Build the register screen so a challenge
> response can be slotted in later (i.e. route both envelope shapes through
> one handler).

## 2. Login — no OTP today

```
POST /api/auth/login
{ "email": "...", "password": "..." }
→ 200 { user, tokens }
→ 401 invalid_credentials       // same error for wrong password AND unknown email, by design
```

## 3. Verify / resend a code (all OTP flows land here)

```
POST /api/auth/otp/verify
{ "challengeId": "<from the challenge envelope>", "code": "123456" }
→ 200 { user, tokens }          // fresh session - REPLACE stored tokens
→ 401 invalid_otp               // wrong code, tries remain - let the user retype
→ 401 otp_attempts_exceeded     // budget burned - start the flow over
→ 401 invalid_challenge         // expired/consumed/unknown - start the flow over

POST /api/auth/otp/resend
{ "challengeId": "..." }
→ 204                           // new code emailed (old code now dead)
→ 429 rate_limited              // cooldown - Retry-After header says how many seconds
→ 401 invalid_challenge         // expired - start the flow over
```

**UI guidance:** 6-digit code input; a "Resend code" button disabled for 60 s
after each send (on a 429, use the `Retry-After` header to set the timer);
on `invalid_otp` clear the input and stay; on the other two 401 codes, exit to
the start of the flow with a "code expired, try again" message. Branch on the
`code` field, never on `message` text.

## 4. Password change (signed in) — OTP-gated

```
POST /api/auth/change-password        (Bearer)
{ "currentPassword": "...", "newPassword": "..." }
→ 200 { challenge }              // code emailed to the ACCOUNT address
→ 401 invalid_credentials        // current password wrong
```

Then verify (§3). On success: the new password is applied, **every other
session and outstanding reset link is revoked**, and you get a fresh session.
The user's other devices will be signed out — say so in the UI.

## 5. Email change (signed in) — OTP-gated, code goes to the NEW address

```
POST /api/auth/change-email           (Bearer)
{ "password": "...", "newEmail": "new@example.com" }
→ 200 { challenge }              // code emailed to new@example.com
→ 401 invalid_credentials | 400 email_unchanged | 409 email_taken
```

Proving the code proves possession of the new mailbox — that's what authorizes
the change. On verify: email swapped, marked verified, all other sessions
revoked (the login identifier changed), fresh session returned. A last-moment
`409 email_taken` on verify is possible (someone claimed the address while the
code was in flight) — surface it and restart.

## 6. Forgot / reset password (signed out) — link-based, NOT OTP

```
POST /api/auth/forgot-password
{ "email": "..." }
→ 204 always                     // even for unknown emails - no account enumeration
```

The email carries a deep link: `tambo://reset-password?token=<opaque>` (the
scheme is the server's `APP_URL`). Register an intent filter for it; the screen
collects a new password and calls:

```
POST /api/auth/reset-password
{ "token": "<from the deep link>", "password": "..." }
→ 200 { user, tokens }           // signed in; ALL old sessions revoked
→ 401 invalid_reset_token        // used/expired/unknown - request a new link
```

Links live 60 minutes, are single-use, and requesting a new one kills the old.

## 7. Email delivery realities the app must handle

- **Sends are fire-and-forget server-side.** The API can return success while
  the email is still in flight (or, in a provider outage, lost). Never spin
  waiting for "email sent" — show "we've emailed a code to x@y.com", offer
  Resend after the cooldown, and let `/otp/resend` be the recovery path.
- **Codes arrive from** `Tambo <no-reply@tambo-app.com>`. Subjects:
  "Your Tambo sign-in code" (login), "Confirm your Tambo password change",
  "Confirm your new Tambo email address", "Verify your Tambo account"
  (signup, when enabled), "Reset your Tambo password".
- **Other Tambo emails users will see** (no app action required, but the app
  copy should set expectations): buddy invites, the theft **first alert**
  ("Tambo alert: <device> may be stolen" — includes IMEIs + last known
  location), and the evidence-pack PDF.
- Tell users to check spam the first time; consider a "didn't get it?" hint
  after ~30 s.

## 8. Rate limits you can hit (all return 429 + `Retry-After` seconds)

`/register`, `/login` (per email+IP), `/otp/verify`, `/otp/resend`,
`/forgot-password`, `/reset-password`. On 429, disable the submit control for
`Retry-After` seconds — do not silently retry.

## 9. Session upkeep (context for all of the above)

- Access tokens are short-lived (~15 min); refresh with
  `POST /api/auth/refresh { refreshToken }` → session envelope. Refresh tokens
  rotate — always store the newly returned pair.
- `GET /api/auth/me` (Bearer) → `{ user }` — feeds the Account screen
  (`emailVerifiedAt`, `createdAt`, role).
- `GET /api/auth/sessions` (Bearer; optionally header `X-Refresh-Token:
  <yours>` to get `current: true` on your own row) and
  `DELETE /api/auth/sessions/:id` — the Active Sessions screen. Send a
  meaningful `User-Agent` (e.g. `Tambo-Android/1.4 (Tecno Spark 20)`) so the
  list reads better than `okhttp/4.9.2`.
