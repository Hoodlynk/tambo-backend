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
register ─────────────────┐
login (unverified email) ──┤                            ┌─> user + tokens (side effects applied)
change-password ───────────┼──> challenge ──> POST /otp/verify
change-email ─────────────┘         │                   └─> 401 wrong/expired code
                                    └─> POST /otp/resend (cooldown-limited)
login (verified email) ──> credentials accepted ──> user + tokens directly
```

---

## POST /register

Creates the account **unverified** and emails a 6-digit signup code — no
session yet. Possession of the mailbox (the code) is what completes signup:
`POST /otp/verify` sets `emailVerifiedAt`, binds any pending buddy invites,
and issues the first session.

```json
{ "name": "Ada Lovelace", "email": "ada@tambo.app", "password": "8+ chars, at most 72 bytes" }
```

`201` → a challenge, **not** tokens:

```json
{ "challenge": { "challengeId": "665f...", "purpose": "signup", "expiresInMinutes": 10 } }
```

| Code | Status | Meaning |
|---|---|---|
| `validation_error` | 400 | See `details` for the offending fields |
| `email_taken` | 409 | A **verified** account owns this address (case-insensitive) |
| `rate_limited` | 429 | 10 per hour per IP |

An address held by an **unverified** account is NOT a conflict: the new
registration supersedes it (name + password replaced, a fresh code sent, the
old code burned). An abandoned signup can never squat an address, and only
whoever can read the mailbox can ever finish claiming it.

Unknown keys are stripped, so posting `"role": "admin"` or `"emailVerifiedAt"`
does nothing.

## POST /login

For a **verified** account, a correct email and password starts a session
directly. For an account whose mailbox was never proven (an abandoned signup),
the same call returns a `login` challenge instead — completing it heals
`emailVerifiedAt` and issues the session.

```json
{ "email": "ada@tambo.app", "password": "..." }
```

`200` → user and token pair (verified account):

```json
{
  "user": { "_id": "...", "name": "Ada Lovelace", "email": "ada@tambo.app", "role": "user" },
  "tokens": { "accessToken": "eyJ...", "refreshToken": "9f3c...", "expiresIn": "15m" }
}
```

`200` → challenge (unverified account):

```json
{ "challenge": { "challengeId": "665f...", "purpose": "login", "expiresInMinutes": 10 } }
```

| Code | Status | Meaning |
|---|---|---|
| `invalid_credentials` | 401 | Wrong password **or** unknown email — deliberately indistinguishable |
| `account_locked` | 423 | Too many consecutive failed logins; retry after `retryAfter` seconds, or reset the password (clears the lock) |
| `rate_limited` | 429 | 5 per 15 min per email+IP |

## POST /otp/verify

Completes whichever flow opened the challenge.

```json
{ "challengeId": "665f...", "code": "123456" }
```

`200` → token pair. Side effects by purpose:

| Purpose | On verify |
|---|---|
| `signup` | `emailVerifiedAt` set; pending buddy invites bound; first session issued |
| `login` | Same as signup (heals verification for an abandoned signup); session issued |
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

## GET /me 🔒

`200` → `{ "user": { ... } }` — includes `emailVerifiedAt`.

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

## The web (PWA) surface — `/api/auth/web/*`

Browsers must not hold refresh tokens where page scripts can read them, so the
PWA uses a parallel surface where the refresh token is an **httpOnly cookie**
(`Secure; SameSite=lax; Path=/api/auth/web`, name `AUTH_COOKIE_NAME`). The
access token still arrives in the body — hold it **in memory only**. Same
services, same rotation/reuse-burning, same rate-limit budgets as the mobile
surface; a token issued on one surface is valid on the other.

| Route | Body | Notes |
|---|---|---|
| `POST /api/auth/web/login` | `{ email, password }` | 200 `{ user, tokens: { accessToken, expiresIn } }` + cookie, or `{ challenge }` (no cookie) |
| `POST /api/auth/web/otp/verify` | `{ challengeId, code }` | completes any challenge; sets the cookie |
| `POST /api/auth/web/refresh` | — | cookie in, rotated cookie out; `missing_refresh_cookie` (401) without it |
| `POST /api/auth/web/logout` | — | revokes + clears the cookie; idempotent 204 |

**Every request needs**: the `X-Tambo-Csrf` header (any value — it forces a
CORS preflight, which the origin allowlist rejects for foreign origins;
missing/foreign-origin ⇒ 403 `csrf_rejected`), and `credentials: 'include'`
on the fetch. The PWA's origin must be listed in `CORS_ALLOWED_ORIGINS`.
Register, forgot-password and reset-password have no cookie involvement — use
the shared `/api/auth` routes.

## Error code index

| Code | Status |
|---|---|
| `validation_error`, `invalid_json` | 400 |
| `no_password_credential`, `email_unchanged` | 400 |
| `unauthorized`, `missing_token`, `invalid_token`, `token_expired` | 401 |
| `invalid_credentials` | 401 |
| `invalid_otp`, `otp_attempts_exceeded`, `invalid_challenge` | 401 |
| `invalid_refresh_token`, `refresh_token_reused` | 401 |
| `invalid_reset_token` | 401 |
| `forbidden` | 403 |
| `route_not_found`, `user_not_found`, `session_not_found` | 404 |
| `email_taken`, `duplicate_key` | 409 |
| `payload_too_large` | 413 |
| `rate_limited` | 429 |
| `internal_error` | 500 |
