# Build plan & status

The single source of truth for where the backend is and what comes next.
Last updated: 2026-11-21 (deploy unit).

**Active program (approved 2026-11-13)**: [program-2026-11.md](program-2026-11.md),
backend sessions B1 snapshots (✅) → B2 remote commands (✅) → B3 partner tenancy +
white-label config + launch handshake (✅) → B4 OEM provisioning and device-first
enrolment (✅) → B5 partner webhooks + status cards (✅). **Next: the revised run order of
2026-11-21 in [program-2026-11.md](program-2026-11.md)** (the app repo is renamed
`tambo-mobile-app` and pushed; the deploy unit is built (below), so the owner deploys per
[deploy.md](deploy.md), then M3a; iOS after the Android release; from this repo it
still needs account deletion). Scoping records:
[oem-zero-screen-readiness.md](oem-zero-screen-readiness.md),
[white-label-scoping.md](white-label-scoping.md).

### ✅ Deploy unit: image, runbook, live-install compatibility (2026-11-21)
Checked the build live on Play (Kevin's `2d8b7d0`, no `X-Client-*` headers) against
`main` first, by replaying its calls ([tests/legacyClient.test.ts](../tests/legacyClient.test.ts)).
Two breaks found and closed for header-less builds only:
- **Unverified-mailbox login:** the build reads `403 email_unverified` + `challenge`;
  `main` answered `200 { challenge }`, which the build shows as "Could not sign you
  in". Header-less callers get the 403 shape; current clients keep the documented 200.
- **Device enrolment:** `main` gates it on server-side legal acceptance, which the
  build never records, so new and re-enrolling installs would silently send no
  evidence. Owner chose (2026-11-21) to exempt header-less builds behind
  `LEGACY_CLIENT_LEGAL_EXEMPT` (default `true`), logging each exempt enrolment.
Also: [Dockerfile](../Dockerfile) and `.dockerignore`, SIGTERM drain in
`server.ts`, [deploy.md](deploy.md) (environment, snapshot, smoke test, rollback).
The image was not built here (no Docker); the production-mode `dist/` boot and a
clean SIGTERM exit were. **Done when** the owner has deployed and the smoke test passes.

**Open, filed here instead of TODOs:** retire both legacy shapes and the flag once
the app update is the minimum version (deploy.md section 1); move the sweep,
watchdog and webhook timers to a single-runner job before running two instances;
the app's `LoginScreen` must branch on a `challenge` in the 200 body (app repo);
drop the pre-push `packDelivery` index `{episode, recipient, kind}` after the first
deploy (`packDelivery.model.ts` note); confirm which versionCode is live on Play.

### ✅ Merged from the remote: quiet-device watchdog and buddy reports (2026-11-16)
Kevin's two commits (2026-09-12, 2026-09-24) are merged into the B1-B5 line.
- **Kept from the remote:** the "went quiet" watchdog (owner emailed when a
  phone stops checking in, after a suspicious signal or after plain silence),
  the single-use mark-stolen link in that email (`GET/POST
  /alert-actions/:token`, HTML pages), `POST /evidence/heartbeat`, idempotent
  self-enrolment by `installId` with optional IMEIs, `GET /protecting` and
  `POST /protecting/devices/:id/report-stolen` (episodes gain `openedBy:
  buddy` and `reportedBy`).
- **Kept from local instead:** the remote's OTP-verification commit. Local
  already gates registration on the emailed code and has `POST
  /auth/verify-email`; the remote's `403 email_unverified` login answer is
  not in the API.
- **Adapted to the current rules:** all five new endpoints are in the OpenAPI
  registry; the watchdog sends through the notifier and logs through pino;
  it skips partner phones nobody has linked; a known install re-enrolling is
  settled before the plan's device cap; a buddy cannot report an ownerless
  phone.

479 tests (+31). Contracts: [devices-api.md](devices-api.md),
[evidence-api.md](evidence-api.md).

**Open, filed here instead of TODOs:** push (not only email) for the quiet
alert; whether the watchdog should also notify a partner's recipients for
unlinked fleet phones; the app must send `installId`, the heartbeat and the
`BOOT` / `UNLOCK_SUCCEEDED` status events before any of this is live.

### ✅ B5: partner webhooks and status cards (2026-11-15)
- **Webhooks.** Partners manage their own endpoints with their API key:
  `POST/GET /partner/webhooks`, `DELETE /partner/webhooks/:id`,
  `POST .../rotate-secret`, `POST .../ping`, `GET .../deliveries`. At most 5
  per partner; the signing secret is shown once. Events: `device.claimed`
  (first claim only), `episode.opened`, `episode.resolved`,
  `snapshot.received` (once per burst during an episode, across batches).
  `Tambo-Signature: t=..,v1=<HMAC-SHA256 of "t.body">`, Stripe-style.
  Delivery is queued per endpoint with the body frozen, deduped by a unique
  (endpoint, event key) index, sent at once and retried 8 times over ~45 h
  by a 30 s sweep; an atomic claim stops the send and the sweep sending one
  attempt twice. Payloads are minimal: no owner identity, device name,
  location or photos; IMEIs only on partner-provisioned phones.
- **SSRF guard.** https only; private, loopback, link-local, CGNAT and
  multicast targets refused inside the socket's own DNS lookup (no
  rebinding), IP literals checked up front, redirects not followed.
  `WEBHOOK_ALLOW_LOCAL_TARGETS=true` (dev/test) relaxes it and refuses to
  boot anywhere else.
- **Status card.** `GET /devices/:id/status-card` (owner): `protected |
  stolen | paused`, last seen, unlock attempts, and during an episode its
  bursts, pending commands and a last location limited to the episode's
  evidence. `GET /evidence/status` (device token, 120/h): `protected |
  unlinked` and the brand only, **never** the episode, because whoever holds
  the phone then is presumably the thief.
- **Partner device read** (deferred from B4): `GET /partner/devices/:id`.

448 tests (+52). Contracts: [webhooks-api.md](webhooks-api.md),
[status-card-api.md](status-card-api.md).

**Deferred, filed here instead of TODOs:**
- **Encrypt webhook secrets at rest.** HMAC needs the secret itself, so it
  is stored as-is (unselected, never serialized). Needs a key-management
  decision alongside the hosting region.
- **Auto-disable a dead endpoint** after a run of failed deliveries, with a
  notice to the partner's `alertRecipients`; and a manual redeliver.
- **A partner integration guide** (key issue, provisioning, webhooks, client
  config) for the readiness checklist, once a first partner is named.

**Open owner decisions:** should partners receive events for phones a
*person* enrolled under their code (today: yes, minimal payload), or only
for phones they provisioned? Should insurers get the IMEIs of those phones
(today: no)? Both belong in the data processing agreement (W7).

### ✅ F4 — camera snapshot bursts (2026-11-13, session B1)
PHOTO envelopes are frames of a burst (`burstId`, `seq`, `count`, `camera`,
`trigger`, `location`, `headingDeg`, read leniently; legacy photos still
ingest). Columns + index on the envelope, `snapshotPolicy` advice beside
`trailCadenceSeconds` (free 3 frames/camera, 2 s, 5 bursts; paid 20), PHOTO
fixes in the trail and the first-alert location, `GET /episodes/:id/snapshots`
grouped per burst with place + familiar annotation, `GET
/episodes/:id/snapshots/:envelopeId` streams a frame (owner-only, episode-
scoped), `snapshotSets` in the pack JSON and a per-set PDF section (two frames
embedded per set), media limit 300/h. 294 tests. Design and platform limits:
[f4-snapshots-scoping.md](f4-snapshots-scoping.md). **Android capture (the
overlay-permission spike on Transsion + Samsung) is the app repo's next native
unit; iOS never gets snapshots.**

### ✅ B2 — remote commands (2026-11-13)
Owner-triggered `snapshot | locate | ring`, **only while an episode is
open**: `POST/GET /devices/:id/commands`, `POST
/devices/:id/commands/:commandId/cancel` (idempotent). A repeated type
converges on the outstanding command. Lifetimes are 30 min snapshot/locate
and 5 min ring; `expired` is derived from the clock, never stored. Resolving
the episode cancels whatever is outstanding; device removal deletes them.
Delivery is at-least-once: `pendingCommands` on ingest replies, `GET
/evidence/commands` (device token, 360/h), and a silent high-priority FCM
data message to the device-bound install. Answers are ordinary envelopes with
`commandId` in the payload: the first result completes the command, `{
outcome: "failed", reason }` fails it, and a command id belonging to another
device is ignored. The verified link is a `commandId` column on the envelope.
`POST /evidence/push-token` (device token) binds an install to its device.

The same unit fixed two push-registry issues it exposed:
- **The stolen phone no longer receives the alert about itself.** First
  alerts and pack nudges skip the install bound to the episode's device.
- **Sign-out and credential rotation keep wake-ups.** A new `alerts` flag on
  push tokens means device-bound installs get alerts switched off instead of
  being deleted, so changing the password right after a theft does not cut
  off remote commands. A device register never turns alerts on.

334 tests (+40). Contract: [commands-api.md](commands-api.md).
**Open owner decisions:** should remote commands be plan-gated (they are not
today)? Should the owner get a push when a command completes? Should the
pack list the owner's commands next to their answers?

### ✅ B4: OEM provisioning and device-first enrolment (2026-11-13)
- **Provision.** `POST /api/v1/partner/devices` (partner key) takes up to
  500 handsets and returns one single-use provisioning token per phone,
  stored hashed. A partner never provisions a handset twice: a unique
  partial index on (partner, IMEI) for provisioned rows. A re-run reissues
  an unclaimed handset's token or reports it `claimed`.
- **Claim.** `POST /api/v1/devices/claim` (no auth, 30/h per IP) trades the
  token for an ingest token. The claiming `installId` is bound (hashed), so
  the same install can retry a lost response until the phone is linked and
  any other install gets 409. `CLAIM_INTEGRITY=off|required` puts Play
  Integrity behind a flag through a verifier seam. `required` refuses to boot
  outside dev/test until the real verifier exists.
- **Link.** `POST /api/v1/devices/:id/link` needs the Bearer session **and**
  the phone's `X-Device-Token`. It is legal-gated, counts against
  `maxDevices`, is idempotent per account, and is refused while an episode is
  open. The owner inherits the phone's episodes and evidence.
- **`Device.user` optional.** The model requires `partner` when `user` is
  absent; `user` is optional on episodes, envelopes and delivery rows. Every
  reader is handled and tested: ingest stores ownerless evidence, and its
  advice follows the partner's `defaultPlan`. An ownerless episode emails the
  partner's `alertRecipients` (deduped per address, logged when there are
  none). Device push registration answers `409 device_not_linked`. Owner
  routes 404, and trail/snapshot builders skip familiar places with no
  owner. The partner resolves an ownerless episode with
  `POST /partner/devices/:id/mark-recovered`; a linked phone is the owner's.

396 tests (+33). Contract: [provisioning-api.md](provisioning-api.md).

**Deferred, filed here instead of TODOs:**
- **The production Play Integrity verifier** (Google decode, package name,
  request hash, `MEETS_DEVICE_INTEGRITY`) behind `src/services/integrity/`.
- ~~A partner device read~~: landed in B5 (`GET /partner/devices/:id`).
- **Push to partner recipients** and an in-app partner console. Ownerless
  alerts are email-only today.
- **Unlink / transfer** of a partner phone between owners (resale, BNPL
  repossession).

**Open owner decisions:** does linking a partner phone grant the partner's
`defaultPlan` (and set `user.partner`) when the account has none? Today it
changes neither. Should provisioning tokens expire?

### ✅ B3: partner tenancy, white-label config, launch handshake (2026-11-13)
- **Partners.** `Partner` records carry a code, a type
  (`oem|insurer|telco|enterprise|bnpl`), a status, a brand (name, logo,
  colour pair, support links), feature flags (buddies, plans, familiar
  locations; never evidence), a `defaultPlan` and `alertRecipients`. Admin
  CRUD lives at `/api/v1/admin/partners`.
- **Partner API keys.** Keys are `tpk_…`, shown once, stored as a SHA-256
  hash plus a prefix. Revocation is idempotent and is recorded in the
  admin's security trail. Keys work only on `/api/v1/partner/*` (`GET
  /partner/me`, 600/h per key).
- **Launch handshake.** `GET /api/v1/client/config?platform=&partner=` is
  public and cacheable for 5 minutes, limited to 1200/h per IP because of
  carrier NAT. It returns the per-platform version policy from
  `CLIENT_MIN_VERSION_*` / `CLIENT_RECOMMENDED_VERSION_*`, plus an `update`
  verdict against `X-Client-Version` (compared numerically; a bad value
  refuses to boot). It also returns the partner's brand or Tambo's, and the
  flags. An unknown code returns 404. A suspended partner keeps its branding
  but loses signups and keys.
- **`partnerCode`** is accepted at register (joins the partner and grants
  its default plan with `planSource: partner`) and at device enrolment
  (otherwise the device inherits the owner's partner). Unknown and suspended
  codes both return `400 unknown_partner`.
- **`planSource`** is exposed on `GET /plan` and settable by the admin.
- **Client headers.** `X-Client-Platform` and `X-Client-Version` are read on
  every request (advisory, never rejected) and recorded on sessions.
  Refresh updates them or inherits the previous values.

363 tests (+25). Contract: [partners-api.md](partners-api.md).

**Deferred, filed here instead of TODOs:**
- **Per-partner legal documents.** Overriding `brand.legal` needs
  per-partner versions in `legal.service` and the enrolment gate.
- **Server-side enforcement of partner feature flags.** Today they shape
  the UI only.
- **An expiry or seat end date for partner-granted plans**, plus the Play
  Billing guard that skips `planSource: partner`. The rule is documented in
  plans-api.md.
- **A seeded demo partner** in `seed:dev` for app-side theming work.

**Open owner decisions:** W1-W7 in
[white-label-scoping.md](white-label-scoping.md). W6, the first design
partner, matters most before B4.

**Active program (approved 2026-09-13)**: depth-first client-readiness &
completion plan — Phase 0 API contract (✅) → 1 PWA cookie auth (✅) →
2 FCM push (✅) → 3 entitlements (✅) → 4 observability (✅) → 5 CI (✅) →
6 onboarding (✅). **The program is complete**, followed by TWO audit passes
(2026-09-14): a 10-angle deep review, then a second pass (fix-commit
regression audit, end-to-end lifecycle traces, data-model/index audit,
test-quality audit, plus a LIVE smoke test of the dev server, the compiled
production build, and the full theft journey over HTTP). All confirmed
findings from both passes are fixed - see the two fix commits for the lists.
Second-pass live verification: register→OTP→legal→enrol→ingest→threshold
auto-open→alert→trail→signed PDF, web cookie login/refresh/reset, CSRF
accept/reject paths, device_limit, rate limiting - all exercised against the
running server.

### ✅ Phase 6 — Onboarding & readability (2026-09-13)
CLAUDE.md (the working rules, incl. the OpenAPI-registry and entitlements
disciplines), ONBOARDING.md (running + seeded backend + typed client in <10
minutes, platform capability matrix), `npm run seed:dev` (verified pro user,
accepted legal docs, enrolled device + ingest token, open episode, located
unlock + moving trail; development-only; logic guarded by tests/seed.test.ts),
README rewritten around the one-API/three-clients story, .DS_Store
gitignored, iCloud "* 2" duplicate artifacts purged from dist/.

### ✅ Phase 5 — CI & coverage gates (2026-09-13)
GitHub Actions on push/PR: typecheck, lint, format:check, full jest with a
coverage RATCHET (thresholds set from measured coverage minus a margin -
raise when coverage rises, never lower), spec-staleness gates (regenerating
openapi.json or the TS client must produce no diff, else the build fails
with instructions), and the typed client uploaded as a build artifact.
`npm run test:coverage` locally. Prettier normalized across the repo so
format:check gates cleanly.

### ✅ Phase 4 — Observability & account protection (2026-09-13)
pino structured logging (request-id middleware honouring sane inbound
`X-Request-Id`, echoed on every response; one line per request; every console
call in src/ replaced except the by-design console drivers and the pre-logger
config boot warning). Append-only auth-event audit trail (365d TTL) covering
logins/OTP/password/email/reset/revocations/lockouts, owner-visible at
`GET /api/auth/security-events`, fire-and-forget writes. Account lockout ON
TOP of rate limiting: per-account counter (catches distributed guessing that
per-email+IP limits miss), 423 `account_locked` + retryAfter, success resets,
password reset clears the lock. security.md rewritten accordingly (email
verification + lockout + logging removed from Known gaps).

### ✅ Phase 3 — Plans & entitlements (2026-09-13; billing webhook parked as 3b)
`User.plan` (free/pro/family) + `planExpiresAt`; ONE matrix in
`services/entitlements.ts` (lapsed paid reads as free). Enforced: device
enrolment cap (409 `device_limit`; existing devices never brick), activity
history window (free: 7 days — episode evidence/packs never clamped),
plan-tuned advisory `trailCadenceSeconds` on ingest responses (evidence never
refused), push alerts as a paid entitlement of the protected account.
`GET /api/v1/plan` backs the Settings row; `PATCH /api/v1/plan/:userId`
(admin) is the manual lever until the Play Billing RTDN webhook (3b, blocked
on the Play Console service account) calls the same `plan.service.setPlan`.

### ✅ Phase 2 — Push notifications via the Notifier seam (2026-09-13)
FCM as the single provider (Android + PWA web push + APNs relay), behind a
driver seam mirroring the mailer (`fcm`/`console`/`noop`, boot-validated).
Token registry: `POST/DELETE /api/v1/push-tokens` — unique tokens
reassign-on-upsert across accounts, per-user cap with LRU eviction,
error-driven pruning when FCM reports a token dead. `notifier.service` is the
one channel fan-out; `delivery.service` claims per channel independently
(the first-alert unique index includes `channel`; push rows store the bare
user id - revised in the 2026-09-14 review). First alert: once per human per channel,
multicast to all devices, lock-screen-safe payloads (no IMEIs/locations).
Full pack: push is a deep-link nudge, never the PDF. Human action open:
create the Firebase project + service account (docs/push-api.md).

### ✅ Phase 1 — Browser-safe (PWA) auth surface (2026-09-13)
`/api/auth/web/{login,otp/verify,refresh,logout}`: refresh token in an
httpOnly `Secure; SameSite=lax; Path=/api/auth/web` cookie (never in the
body), access token in-memory client-side. CSRF: required `X-Tambo-Csrf`
header + Origin-vs-allowlist check (`csrf_rejected` 403); CORS `credentials`
enabled only when `CORS_ALLOWED_ORIGINS` is non-empty. `session.service`
untouched - one session machinery across both surfaces (tested cross-surface),
shared rate-limit budgets, cookie-flag misconfigurations refuse to boot.
In the OpenAPI spec under the "Auth (web)" tag.

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

### ⬜ Episode archival on device removal
Deleting a device deletes its resolved episodes; evidence ages out on TTL and
past packs become unbuildable (documented caveat in devices-api.md). Design an
archive: either forbid removal while unexported episodes exist, or snapshot
the pack JSON/PDF to storage at removal time. Surfaced by the 2026-09-14
lifecycle audit.

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

### ✅ F3 — location trail, static vs moving, familiar locations (2026-09-09)
Built exactly as scoped in [f3-location-trail-scoping.md](f3-location-trail-scoping.md);
API reference in [trail-api.md](trail-api.md). `GET /episodes/:id/trail`
(ordered fixes from TRAIL_POINT + UNLOCK_FAILED, static/moving/unknown
classification, familiar annotation, "left familiar location" departure),
familiar-locations CRUD (`/api/v1/familiar-locations`, cap 10, interpretation
only — never touches thresholds/episodes/alert decisions), pack JSON gains
`trailSummary` + per-point `familiar` (trail points now parse the nested
`location` payload shape too), PDF trail section renders static vs moving,
first-alert email annotates the last known location with the familiar place.
Owner decisions taken (2026-09-09): departures enrich existing reports only
(no additional email yet); familiar places are owner-entered only in v1.

### ✅ Phase 0 — API contract & client enablement (2026-09-13)
OpenAPI 3.0 generated from the SAME zod schemas the server validates with
(`src/openapi/registry.ts` + `responses.ts`), served at `GET /api/openapi.json`
and committed to `openapi/openapi.json` (`npm run openapi`); typed TS client
via `npm run client:ts` (Swift command documented). Tests validate the document
(swagger-parser) and probe every documented path against the live router, so
spec↔server drift fails the suite. Plus: `POST /auth/verify-email` (legacy
unverified accounts; 409 `email_already_verified`), canonical `/api/v1/auth`
mount (legacy `/api/auth` alias kept), `docs/README.md` index,
`docs/client-generation.md`, and the Android contract-fix brief
(`docs/android-feedback-2026-09-12.md`).

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
