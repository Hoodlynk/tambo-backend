# Auth API

Base path `/api/auth`. All bodies are JSON. All errors use the envelope
described in [architecture.md](architecture.md#error-model) — **branch on
`code`, not on `message`.**

Authenticated endpoints expect:

```
Authorization: Bearer <accessToken>
```

## The OTP model

Sensitive authentication changes are completed by a 6-digit code emailed to
the relevant mailbox. Endpoints that start those actions return a **challenge**
instead of tokens:

```json
{ "challenge": { "challengeId": "665f...", "purpose": "password_change", "expiresInMinutes": 10 } }
```

The client then collects the code from the user and calls `POST /otp/verify`,
which returns the **token pair**:

```json
{
  "user": { "_id": "...", "name": "Ada Lovelace", "email": "ada@tambo.app", "role": "user", "emailVerifiedAt": "...", "createdAt": "...", "updatedAt": "..." },
  "tokens": { "accessToken": "eyJ...", "refreshToken": "9f3c...", "expiresIn": "15m" }
}
```

`passwordHash` is never serialized. Codes expire after 10 minutes, allow 5
wrong guesses, and are single-use. A new challenge for the same purpose kills
the previous one.

```
register ─────────────────────────> signup challenge ──┐
login (email unverified) ── 403 ──> signup challenge ──┤
verify-email 🔒 ──────────────────> signup challenge ──┤
change-password 🔒 ┐                                   ├──> POST /otp/verify ──┬─> user + tokens (email verified /
change-email 🔒 ───┴──> challenge ─────────────────────┘        │              │   password/email applied)
                                                                │              └─> 401 wrong/expired code
                                                                └─> POST /otp/resend (cooldown-limited)
login (email verified) ──> credentials accepted ──> user + tokens
```

---

## POST /register

Creates the account with its email **unverified** and opens a `signup`
challenge whose code is emailed to the new address. **No session is issued** —
the first token pair comes from `POST /otp/verify`, which also sets
`emailVerifiedAt`. Until then the account cannot log in (see `/login`). A lost
code is recovered with `POST /otp/resend`, or by logging in again, which
issues a fresh challenge.

```json
{ "name": "Ada Lovelace", "email": "ada@tambo.app", "password": "8+ chars, at most 72 bytes" }
```

`201` → challenge only:

```json
{
  "challenge": { "challengeId": "665f...", "purpose": "signup", "expiresInMinutes": 10 }
}
```

| Code | Status | Meaning |
|---|---|---|
| `validation_error` | 400 | See `details` for the offending fields |
| `email_taken` | 409 | Case-insensitive; `A@x.com` collides with `a@x.com` |
| `rate_limited` | 429 | 10 per hour per IP |

Unknown keys are stripped, so posting `"role": "admin"` does nothing.

## POST /login

A correct email and password starts a session directly — **for a verified
email**. An account that never completed its signup code gets no session:
the password is still checked first, then a fresh `signup` challenge is
returned inside a `403 email_unverified` error so the client can send the
user straight to the code screen. Verifying it completes the signup and
returns the token pair.

```json
{ "email": "ada@tambo.app", "password": "..." }
```

`200` → user and token pair:

```json
{
  "user": { "_id": "...", "name": "Ada Lovelace", "email": "ada@tambo.app", "role": "user", "emailVerifiedAt": "..." },
  "tokens": { "accessToken": "eyJ...", "refreshToken": "9f3c...", "expiresIn": "15m" }
}
```

`403` (`email_unverified`) → the standard error envelope plus a challenge:

```json
{
  "code": "email_unverified",
  "message": "Verify your email address to finish signing up.",
  "challenge": { "challengeId": "665f...", "purpose": "signup", "expiresInMinutes": 10 }
}
```

| Code | Status | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | Wrong password **or** unknown email — deliberately indistinguishable |
| `email_unverified` | 403 | Password correct, signup code never verified; `challenge` included |
| `rate_limited` | 429 | 5 per 15 min per email+IP |

## POST /otp/verify

Completes whichever flow opened the challenge.

```json
{ "challengeId": "665f...", "code": "123456" }
```

`200` → token pair. Side effects by purpose:

| Purpose | On verify |
|---|---|
| `signup` | `emailVerifiedAt` set; buddy invites waiting on the address bound; the account's **first** session issued |
| `password_change` | New password applied; **every other session and reset link revoked**; fresh session issued |
| `email_change` | Email updated + verified; **every other session and reset link revoked**; fresh session issued |

| Code | Status | Meaning |
|---|---|---|
| `invalid_otp` | 401 | Wrong code; the challenge survives (attempts remaining) |
| `otp_attempts_exceeded` | 401 | 5 wrong guesses; challenge burned — restart the flow |
| `invalid_challenge` | 401 | Unknown, expired, consumed, or superseded challenge |
| `email_taken` | 409 | email_change only: the address was claimed while the code was in flight |
| `rate_limited` | 429 | 15 per 15 min per IP |

## POST /otp/resend

```json
{ "challengeId": "665f..." }
```

`204`. Rotates the code (the old one dies) without extending the challenge's
expiry or attempt budget.

| Code | Status | Meaning |
|---|---|---|
| `invalid_challenge` | 401 | Not an active challenge |
| `rate_limited` | 429 | 60s per-challenge cooldown (`retryAfter` says how long), plus 6 per 10 min per IP |

## POST /refresh

```json
{ "refreshToken": "9f3c..." }
```

`200` → a **new** pair. The presented token is now dead: rotation means storing
the replacement and discarding the old one.

| Code | Status | Meaning |
|---|---|---|
| `invalid_refresh_token` | 401 | Unknown, expired, revoked family, or the account is gone |
| `refresh_token_reused` | 401 | Replay detected — **every session in that family was just revoked.** Send the user to sign-in |
| `rate_limited` | 429 | 60 per hour per IP |

### Client contract

On any `401` from a normal API call with `code: "token_expired"`, call
`/refresh` once and retry. On `refresh_token_reused` or
`invalid_refresh_token`, clear stored tokens and show the login screen — do not
retry.

## POST /logout

```json
{ "refreshToken": "9f3c..." }
```

`204`. Idempotent — an unknown token also returns `204`, revealing nothing.
Revokes only that session.

## POST /forgot-password

```json
{ "email": "ada@tambo.app" }
```

`204` **always**, whether or not the account exists — otherwise the endpoint
becomes an account-existence oracle. This flow is link-based rather than
challenge-based on purpose: returning a `challengeId` would leak which emails
are registered. Requesting a new link invalidates any previous one.

| Code | Status | Meaning |
|---|---|---|
| `rate_limited` | 429 | 3 per hour per email+IP |

## POST /reset-password

```json
{ "token": "<from the emailed link>", "password": "new password" }
```

`200` → token pair. Single use, expires after `PASSWORD_RESET_TTL_MINUTES`
(default 60), and **revokes every existing session** for that user.

| Code | Status | Meaning |
|---|---|---|
| `invalid_reset_token` | 401 | Unknown, already used, or expired |
| `rate_limited` | 429 | 10 per hour per IP |

---

## POST /change-password 🔒

```json
{ "currentPassword": "...", "newPassword": "8+ chars, at most 72 bytes" }
```

`200` → `password_change` challenge. **Nothing changes until the code is
verified** — the new password rides on the challenge. Verifying applies it,
revokes every existing session and outstanding reset link, and returns a fresh
pair.

| Code | Status | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | `currentPassword` is wrong (no challenge opened, no mail sent) |
| `no_password_credential` | 400 | Account has no password (a future OTP-only account) |

## POST /change-email 🔒

```json
{ "newEmail": "new@tambo.app", "password": "..." }
```

`200` → `email_change` challenge. The code is sent to the **new** address —
possession of the new mailbox is what authorizes the change. Verifying updates
the email (marked verified), revokes every existing session, and returns a
fresh pair. The old address can no longer log in.

| Code | Status | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | Password is wrong |
| `email_unchanged` | 400 | Same address as current |
| `email_taken` | 409 | Address belongs to another account |

## POST /verify-email 🔒

No body. Opens a `signup` challenge for the caller's own address. Since a
session is only ever issued to a verified email, this only applies to a
session that predates that rule (an account still holding tokens while
`GET /me` shows no `emailVerifiedAt`) — clients should surface it then. Any
earlier `signup` challenge is superseded. An account with no session at all
recovers a lost code via `POST /otp/resend` or by logging in again.

`200` → `signup` challenge envelope.

| Code | Status | Meaning |
|---|---|---|
| `email_already_verified` | 400 | Nothing to do |
| `no_email` | 400 | Account has no email address (a future phone-only account) |
| `rate_limited` | 429 | 6 per 10 min per IP |

## GET /me 🔒

`200` → `{ "user": { ... } }` — includes `emailVerifiedAt`, absent until the
signup code (or a later `/verify-email` code) has been verified.

## POST /logout-all 🔒

`204`. Revokes every session for the caller, this device included.

## GET /sessions 🔒

Optionally send `X-Refresh-Token: <your refresh token>` to have your own row
flagged `current`. A header rather than a query parameter, because query
strings end up in access logs.

```json
{
  "sessions": [
    { "id": "665f...", "userAgent": "Tambo/1.0 (iOS 17)", "createdAt": "...", "expiresAt": "...", "current": true }
  ]
}
```

## DELETE /sessions/:id 🔒

`204`. Revokes one session belonging to the caller.

| Code | Status | Meaning |
|---|---|---|
| `session_not_found` | 404 | Unknown, already revoked, **or owned by someone else** — the same answer either way, so ids cannot be probed |

---

## Health

### GET /api/health

`200` when the database is connected, `503` when it is not — point your load
balancer at this.

```json
{ "status": "ok", "database": "connected", "uptime": 42, "timestamp": "..." }
```

## Error code index

| Code | Status |
|---|---|
| `validation_error`, `invalid_json` | 400 |
| `no_password_credential`, `email_unchanged`, `email_already_verified`, `no_email` | 400 |
| `unauthorized`, `missing_token`, `invalid_token`, `token_expired` | 401 |
| `invalid_credentials` | 401 |
| `invalid_otp`, `otp_attempts_exceeded`, `invalid_challenge` | 401 |
| `invalid_refresh_token`, `refresh_token_reused` | 401 |
| `invalid_reset_token` | 401 |
| `forbidden`, `email_unverified` | 403 |
| `route_not_found`, `user_not_found`, `session_not_found` | 404 |
| `email_taken`, `duplicate_key` | 409 |
| `payload_too_large` | 413 |
| `rate_limited` | 429 |
| `internal_error` | 500 |
