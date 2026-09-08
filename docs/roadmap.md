# Build plan & status

The single source of truth for where the backend is and what comes next.
Last updated: 2026-09-04.

Legend: ✅ done & tested · 🔶 partially done · ⬜ not started · 👤 needs a human action

---

## Done

### ✅ Phase 0 — Scaffold cleanup
Toolchain baseline: strict TypeScript for `src/` **and** `tests/`, ESLint +
Prettier, Jest against a real in-memory MongoDB (one shared server, random
database per test file), scripts for build/typecheck/lint/format/test.

### ✅ Phase 1 — Auth core
JWT access tokens (15 min, stateless) + opaque rotating refresh tokens
(30 days, SHA-256 hashed at rest, per-login families, reuse detection burns the
family). Endpoints: register, login, refresh, logout, logout-all, me.
User model already carries `phone` / `phoneVerifiedAt` (sparse-unique) so
phone OTP needs **no migration**.

### ✅ Phase A — Validation
zod schemas as the single source of request shapes; `validate()` middleware
strips unknown keys (mass-assignment proof) and reports every bad field at once.

### ✅ Phase B — Service layer
Credential-agnostic `session.service` + `credentials/password.credential`;
controllers never touch models; pluggable mailer (console/noop drivers).

### ✅ Phase C — Password lifecycle
change-password, forgot-password (always 204), reset-password. Reset tokens:
opaque, hashed, single-use via atomic claim, 60-min TTL. Any password set goes
through one `setPassword` mechanism that revokes all sessions **and** all
outstanding reset links.

### ✅ Phase D — Abuse protection
Mongo-backed rate limiting (correct across instances): login 5/15min per
email+IP, register 10/hr, forgot-password 3/hr, reset 10/hr, refresh 60/hr.
Windows anchor on first hit; stale windows reset immediately.

### ✅ Phase E — Hardening
helmet, deny-all CORS default, 100kb body cap, validated TRUST_PROXY,
`/api/health` (503 when DB down), session list + per-device revocation,
structured 4xx logging, hello-world scaffold removed.

### ✅ Deep audit + fixes (2026-09-04)
8-angle review, top findings verified live, **all 17 applied** — including the
two real security bugs (stale reset-link account takeover; refresh rotation
race) and the fail-silent config traps (JWT secret fallback, TRUST_PROXY,
MAIL_DRIVER — all now refuse to boot instead). Prod dependencies audit clean
(`qs` overridden to a patched version).

### ✅ Email OTP everywhere + Resend driver (2026-09-05)
Every authentication-changing action now completes via a 6-digit emailed code:
signup (verifies the account), every login, password change, email change (code
goes to the NEW address). Codes bcrypt-hashed, 5 attempts, 10-min TTL, atomic
single-use, cooldown-limited resend. Register/login return a `challenge`;
`/otp/verify` returns tokens. Resend mail driver ready behind
`MAIL_DRIVER=resend` (blocked on domain verification - see docs/cloudflare.md).
Race-proof bulk revocation added (family tombstones + per-user watermark).
Deliberate UX choice by the owner: OTP on EVERY login; relaxing to
new-devices-only later means gating `login`'s createChallenge call on an
unrecognized userAgent/device id.

**Current state: 105 tests green, lint/typecheck/build clean.
Committed and pushed 2026-09-05.**

---

## Open items

### 👤 Immediate human actions
1. ✅ **Commit the work** — committed as a series and pushed (2026-09-04).
2. ✅ **Rotate the Atlas password** — rotated (2026-09-04); `.env` updated and
   the connection verified.
3. ✅ **Email provider LIVE (2026-09-05)**: `tambo-app.com` verified in Resend
   (eu-west-1, sending on, receiving deliberately off), production sends
   confirmed end-to-end through the app's driver. `MAIL_DRIVER=resend`,
   `MAIL_FROM=Tambo <no-reply@tambo-app.com>`. SMS provider still undecided;
   phone OTP waits on it.
4. 👤 **Cloudflare — PARKED, owner is handling it** (2026-09-05). Zone is on
   Cloudflare nameservers and Resend records are live; remaining runbook items
   (stray apex TXT deletion, SSL Full-strict, API proxying, TRUST_PROXY) are
   with the owner. docs/cloudflare.md stays the reference.
5. 👤 **Rotate the Resend API key** after setup — it was pasted into a chat
   conversation (same hygiene as the Atlas password was).

### ⬜ Phone OTP login — designed-for, ON HOLD until providers are settled

**Owner's call (2026-09-04): do not start until the SMS/notification provider
is chosen, settled alongside the email provider.** Both feed the same
`Notifier` seam, so picking them together avoids building the abstraction
twice. Everything below is ready to go the moment that lands.
Already in place: `phone`/`phoneVerifiedAt` fields (no migration),
`passwordHash` optional (OTP-only accounts are valid), credential-agnostic
sessions (token issuance/rotation/revocation reused unchanged), rate-limit
machinery, `no_password_credential` error path.

To build:
1. `models/otpChallenge.model.ts` — hashed code, TTL, attempt counter (same
   opaque-token discipline; helpers already generalized).
2. `services/credentials/otp.credential.ts` mirroring the password credential.
3. `POST /auth/otp/request` + `POST /auth/otp/verify`.
4. Generalize `Mailer` → `Notifier` with an SMS driver.
5. E.164 normalization (`libphonenumber-js`) before storage.
6. Rate limits: per phone, per IP, resend cooldown.

**✅ Decision made (2026-09-04): ONE account.** A human with both a phone and
an email is a single `User` document carrying both identifiers. Consequences
for the OTP build:

- `User` keeps one row per person; `email` and `phone` are independent
  sparse-unique fields on it — no separate identity table.
- Logging in via either identifier resolves to the same account and the same
  sessions/roles.
- **Linking requires proof of ownership**: adding a phone to an email account
  (or vice versa) must verify the new identifier (OTP to the phone, link to the
  email) while authenticated — never silently merge two records that share
  nothing but a claimed identifier.
- Registering a phone that already belongs to an account is a conflict
  (`phone_taken`), mirroring `email_taken` — not an auto-merge.

### 🔶 Observability — scheduled after the email service is up
Minimal structured 4xx logging exists (audit fix). The rest of this batch is
deliberately sequenced behind the email provider (owner's call, 2026-09-04):
real logger with request ids, auth-event audit trail, email verification, the
real mail driver, account lockout, 2FA, OpenAPI spec, CI pipeline.

### ⬜ Remaining batch (was email-gated; mail driver + verification now DONE)
1. ✅ ~~Real mail driver~~ — Resend driver built; domain verification pending.
2. ✅ ~~Email verification~~ — subsumed by OTP: signup verifies, login heals
   unverified accounts, email change verifies the new address.
3. **Observability** — real logger with request ids, auth-event audit trail.
4. **Account lockout** on top of rate limiting (OTP attempt caps already bound
   code guessing).
5. **2FA (TOTP)** — lower priority now that every login is already emailed-OTP
   confirmed.
6. **OpenAPI spec** generated from the zod schemas → typed mobile client.
7. **CI pipeline** (typecheck + lint + test; `MONGOMS_VERSION` pin is
   macOS-12-only, Linux runners use the default).

### 👤 At deploy time
- Set `TRUST_PROXY` to the real proxy hop count (boot fails on non-integers).
- Set `CORS_ALLOWED_ORIGINS` only if a browser client exists (empty = deny all,
  correct for mobile-only).
- `NODE_ENV=production` + real `JWT_ACCESS_SECRET` (boot fails without it).

### 🔶 IN PROGRESS: the first three major product features
**F-A DONE (2026-09-05)**: devices (owner-entered IMEIs, one-shot ingest
tokens, rotation/revocation), theft episodes (owner mark-stolen/recovered,
DB-enforced single open episode, race-converging opener - the seam F-B's
threshold trigger calls), trusted contacts (real consent state machine,
single-use atomic accept/decline links, cooldown-limited nominations).
**F-B DONE (2026-09-05)**: idempotent hash-verified envelope ingest with
per-envelope ACKs, device-token auth, server-clock threshold trigger that
auto-opens episodes and back-attaches the leading evidence, GridFS media
uploads (hash-verified, idempotent, size-capped) behind a storage seam, and
retention-as-code (TTL indexes + hourly GridFS sweep).
**F-C DONE (2026-09-05)**: Kenya-mapped evidence pack (JSON + PDF with
embedded photos), Ed25519-signed integrity manifest (tamper-evident business
record, never "forensic"), automatic first-alert email on episode open (once
per recipient per episode via DB claim), full-pack email with PDF attachment
to owner + eligible contacts, per-recipient delivery audit.

### ✅ Buddy ecosystem redesign (2026-09-05)
Trusted contacts (outside emails + emailed consent links) replaced by
**buddies**: a directed link to a Tambo USER who accepts IN-APP. Invite by
email resolves to an existing user or auto-binds when they sign up; only
accepted buddies receive alerts; the public unauthenticated consent surface is
gone. Gives every buddy a User id, so in-app / push / WhatsApp delivery has a
real recipient, not just an address. Endpoints: `/api/v1/buddies` (owner),
`/api/v1/buddy-invites` (buddy).

**All three features (F-A, F-B, F-C) are built. The defensible core - "a
theft becomes a filed, evidenced, insurer-ready pack" - is live end to end:**
enrol device → evidence uploads → episode opens (threshold or owner) →
first alert in seconds → signed pack by email.

### The feature plan
Planned in detail in [evidence-features-plan.md](evidence-features-plan.md):
**F-A** Devices, Theft Episodes & Trusted Contacts (device tokens, mark-stolen,
consent state machine) → **F-B** Evidence Ingest (idempotent envelopes, hash
verification, GridFS media, retention-as-TTL) → **F-C** Evidence Pack &
Delivery (Kenya-mapped JSON+PDF, Ed25519-signed manifest, first-alert +
full-pack email via the live Resend spine). WhatsApp deferred. One open gate
flagged for the owner: **hosting region** (blocks the DPIA, not the code).

### 🔶 F1 — failed-unlock detection (backend done; Android side missing)
Backend half is live: ingest counts `UNLOCK_FAILED` envelopes, threshold
auto-opens episodes, and `GET /devices/:id/activity` is the owner report. The
Android app does **not** yet implement detection or upload — audit of the app
repo plus the exact fix (manifest wiring, `onPasswordFailed`, native evidence
queue, WorkManager uploader, enrolment flow) is in
[f1-android-audit.md](f1-android-audit.md); the wire contract it targets is
[f1-client-contract.md](f1-client-contract.md).

### Open product decision: access tier
Whether Tambo stays a consumer-Play app (device-admin failed-unlock detection
is the capability ceiling) or gains a **Device-Owner edition** for enrolled
devices (the only lawful, consented route to kernel-depth access) is a
distribution decision, not an engineering one — the backend serves both
unchanged. Full analysis in
[access-tiers-decision.md](access-tiers-decision.md).

## Not planned
- Cookie/session auth for browsers — the API is token-based and mobile-first.
- Social login — no requirement yet.
