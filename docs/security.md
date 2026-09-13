# Security notes

What is defended, how, and what is knowingly left open.

## Passwords

- **bcrypt**, work factor 12 (`BCRYPT_ROUNDS`). Tests drop to 4 for speed.
- Hashes use `select: false`, so they are excluded from queries unless a caller
  explicitly opts in, and are stripped again in `toJSON`.
- Passwords are capped at **72 bytes** (not characters - multibyte UTF-8
  counts). bcrypt silently ignores bytes past 72, so any larger cap would let
  two different long passwords open the same account.

## Email OTP

Every authentication-changing action (signup, login, password change, email
change) is completed by a 6-digit code emailed to the relevant mailbox:

- Codes are **bcrypt-hashed** at rest. Unlike the high-entropy opaque tokens
  (sha256), a 6-digit code space (1e6) is trivially brute-forced offline
  against a fast hash, so OTP codes get the slow one.
- Online guessing is bounded three ways: 5 wrong attempts burn the challenge,
  10-minute expiry, and an IP rate limit on /otp/verify.
- Consumption is an atomic claim (consumedAt flips only while unset), so a
  concurrent double-submit cannot complete one challenge twice.
- Resending rotates the code without extending expiry or the attempt budget.
- A new challenge for the same user+purpose burns the previous one.
- The pending side effect (new email, new password hash) rides ON the
  challenge; nothing changes until the code is proven. email_change codes go to
  the NEW address - possession of the claimed mailbox authorizes the change.

## Account enumeration

Three endpoints could otherwise reveal who has an account:

| Endpoint | Defence |
|---|---|
| `/login` | Identical `invalid_credentials` for unknown email and wrong password, **and** a bcrypt comparison against a dummy hash when the user is missing, so timing does not leak either |
| `/forgot-password` | Always `204`, mail sent only if the account exists |
| `/register` | Genuinely does leak, by necessity — `email_taken` is unavoidable. Rate limiting is the mitigation |

## Token storage

Refresh tokens and password-reset tokens are random opaque values; only their
SHA-256 hashes are persisted. A database dump therefore yields no usable
sessions and no password-reset capability.

Access tokens are not stored at all — that is the point of them being stateless.

## Session revocation

Every path that should evict an attacker does:

| Event | Effect |
|---|---|
| Refresh token replayed | Whole family revoked (tombstoned) |
| Email changed (OTP-verified) | All sessions revoked, all reset links invalidated, fresh pair returned |
| Password changed | All sessions revoked, all outstanding reset links invalidated, fresh pair returned |
| Password reset | All sessions revoked, all other reset links invalidated, fresh pair returned |
| `/logout-all` | All sessions revoked |
| `DELETE /sessions/:id` | That session revoked |

Refresh rotation, reset-token consumption, and OTP consumption all use an
**atomic claim** (`findOneAndUpdate` flipping the revoked/used marker only
while unset), so a concurrent replay cannot slip through the read-check-write
gap.

Bulk revocation is additionally race-proof against in-flight rotations, which
could otherwise write a fresh token after the revoking `updateMany` ran:

- A replayed family gets a **tombstone** (`burnedfamilies`) written before the
  sweep, and every rotation re-checks the tombstone after issuing - so under a
  concurrent replay, at most one presenter briefly wins and its token is
  already dead by the time it could be used.
- "Sign out everywhere" stamps a **watermark** (`User.sessionsInvalidatedAt`)
  before its sweep; rotations of any token created before the watermark are
  rejected at use time and self-revoke anything they issued.

The residual window is the access token's remaining lifetime, at most 15
minutes by default.

## Rate limiting

Counters live in MongoDB rather than memory, so limits hold across multiple
instances — an in-memory counter would let *N* instances permit *N* times the
intended budget.

Keys are `sha256(ip | subject)` truncated, so the counter collection is not a
harvestable list of email addresses.

The window is anchored on first hit (`$setOnInsert`), so a burst cannot keep
pushing the expiry forward and starve the reset.

**`TRUST_PROXY` must match your real topology.** Setting it higher than the true
number of proxies lets any client forge `X-Forwarded-For` and sidestep every
IP-keyed limit.

## Transport and headers

`helmet` for standard security headers, `x-powered-by` disabled, JSON bodies
capped at 100kb, and CORS denied by default — a native mobile client sends no
`Origin` and needs no CORS grant. Add browser origins to
`CORS_ALLOWED_ORIGINS` only when a web client actually exists.

## Mass assignment

Every request body is parsed by a zod schema that **strips unknown keys** before
anything reaches a model. Posting `role: "admin"` to `/register` is inert, and
there is a test asserting exactly that.

## Account lockout (on top of rate limiting)

Rate limiting is keyed per email+IP, so a distributed guess (many IPs, one
account) slides under it. The lockout counter is per ACCOUNT: after
`LOCKOUT_THRESHOLD` consecutive failed password logins the account answers
**423 `account_locked`** (with `retryAfter`) for `LOCKOUT_DURATION_MINUTES`,
regardless of the password — running the comparison while locked would turn
the lock into a guessing oracle. A successful login resets the counter, and **proving mailbox control clears
the lock early** - via a password-reset link OR by completing any emailed OTP
challenge (the real owner must always have a way back in, and a lock must
never coexist with a freshly issued session). Trade-off, stated plainly: a 423 confirms the account
exists to someone who already has the email; accepted, since the alternative
(silent lock) turns lockout into an unexplainable login failure for the owner.
Locks and failures land in the audit trail.

## Observability

- **Structured logs** (pino, JSON lines): every request gets an
  `X-Request-Id` (inbound ids honoured only behind a trusted proxy -
  `TRUST_PROXY > 0` - and only when sane; echoed always), one line per
  completed request, one `warn` per expected 4xx, full error objects for 500s.
  Redaction is configured, but the primary rule is that tokens, codes, and
  password material are never passed to a log call at all.
- **Auth-event audit trail** (`authEvent` collection, 365-day TTL,
  append-only): logins (success/failure/OTP-challenged), OTP outcomes,
  password/email changes, reset requests and resets, session revocations,
  lockouts — with ip/userAgent. Owner-visible at
  `GET /api/auth/security-events`; writes are fire-and-forget so auditing can
  never break auth.

## Known gaps

Deliberate, and worth revisiting before public launch:

1. **No 2FA (TOTP).** Lower priority: every login on an unproven mailbox is
   already OTP-confirmed, and password logins are lockout-protected.
2. **Access tokens cannot be revoked mid-life** (see architecture.md).
3. **Secrets come from the environment**; there is no integration with a managed
   secret store, and no key rotation scheme for `JWT_ACCESS_SECRET` — rotating
   it invalidates every access token immediately (refresh tokens survive,
   because they are database-backed rather than signed).
