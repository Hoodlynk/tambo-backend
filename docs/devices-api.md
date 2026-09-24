# Devices, Episodes & Trusted Contacts API (F-A)

Base path `/api/v1`. Same envelope and conventions as [auth-api.md](auth-api.md):
errors are `{ code, message }`, branch on `code`. All endpoints require
`Authorization: Bearer <accessToken>` except the public consent links.

## Devices

### POST /devices 🔒
Enrols a phone. IMEIs are owner-entered (Android 10+ blocks reading them).

```json
{ "name": "My Tecno", "imeis": ["356938035643809"], "make": "Tecno",
  "deviceModel": "Spark 20", "colour": "black", "purchaseInfo": "..." }
```

`201` → `{ device, ingestToken }`. **`ingestToken` appears in this response and
never again** — store it on the phone; only its hash is kept server-side. It is
the device's evidence-upload credential (header `X-Device-Token`, F-B): valid
even after the owner's sessions are revoked, and useless for anything but
ingest if it leaks.

**Self-enrolment.** The app enrols the phone it runs on at every sign-in, so
two fields make that safe:

- `imeis` is optional (the app cannot read them; the owner adds them later
  via PATCH). A list that *is* sent must still hold 1-2 IMEIs.
- `installId` (8-64 url-safe chars, stable per phone) makes the call
  idempotent per (owner, install): a known install answers **`200`** with the
  same device and a **fresh token** (the old one dies). Owner-edited fields
  (name, IMEIs, threshold) are never overwritten by a re-enrolment.
  Self-enrolment counts as contact for the quiet-device watch (below).

### GET /devices 🔒 · GET /devices/:id 🔒 · PATCH /devices/:id 🔒 · DELETE /devices/:id 🔒
Standard management. Reads/writes are owner-scoped; someone else's device id
404s exactly like a missing one. `DELETE` returns `409 episode_open` while a
theft episode is open — resolve first.

### POST /devices/:id/token 🔒 → `{ ingestToken }` (rotates; old token dies instantly)
### DELETE /devices/:id/token 🔒 → 204 (revokes; device cannot upload until re-enrolled)

### GET /devices/:id/activity 🔒
The owner's failed-unlock report — "has anyone been trying my PIN?" Surfaces
attempts even **below** the threshold, which are otherwise invisible until an
episode opens. Counts by SERVER receipt time, so a lying device clock cannot
skew it.

```json
{
  "activity": {
    "inWindow": 2, "threshold": 3, "toThreshold": 1,
    "windowMinutes": 10, "lastAttemptAt": "2026-09-07T18:31:02.114Z",
    "recent": [ { "capturedAt": "...", "receivedAt": "..." } ]
  }
}
```

The *detection* of a wrong unlock happens on the phone (Android device-admin
`onPasswordFailed`); the device uploads `UNLOCK_FAILED` evidence, and this
endpoint plus the threshold auto-episode + first-alert (F-B) are the reporting
half.

## Theft episodes

One episode = one theft incident; all evidence and the eventual report group
under it. The database enforces at most ONE open episode per device.

### POST /devices/:id/mark-stolen 🔒
Body: `{ "note": "snatched at Kencom stage ~18:30" }` (optional).
`201` when this call opened the episode, `200` when converging on one already
open (the device's own threshold signal may have fired first — F-B). Flips the
device to `stolen`.

### POST /devices/:id/mark-recovered 🔒
`200` → resolved episode (`resolution: "recovered"`); device back to `active`.
`404 episode_not_found` when nothing is open.

### GET /episodes?deviceId= 🔒 · GET /episodes/:id 🔒

## The evidence pack (F-C)

The dossier the product exists to produce (Evidence doc S4): incident summary,
device identity (owner-entered IMEIs), failed-unlock log, location trail with
maps links, photos, the Kenya action checklist (OB, eCitizen abstract, IMEI
blacklist, insurer), and a signed integrity manifest.

### GET /episodes/:id/pack 🔒
`200` → `{ pack }` - the machine-readable JSON pack. `pack.integrity` carries
per-item SHA-256 hashes (verified at ingest), server receipt timestamps, the
Ed25519 public key, and a signature over the canonical manifest JSON. Wording
discipline: this is a TAMPER-EVIDENT BUSINESS RECORD, never claimed as
forensic certification.

### GET /episodes/:id/pack.pdf 🔒
`200` → the human-readable PDF (photos embedded when decodable), the document
an owner forwards to an insurer or shows at a police station.

### POST /episodes/:id/send-pack 🔒
Builds the pack and emails the PDF to the owner and every eligible trusted
contact (pending + opted_in; declined/revoked are never contacted). Returns
`{ recipients }`. Re-sending is allowed - more evidence may have landed - and
every send is recorded. Rate-limited (10/hour).

### First alerts (automatic)
The moment an episode opens - owner mark-stolen OR the device threshold - a
tiny first-alert email goes to the owner and eligible contacts (Evidence doc
S2.3: time-to-first-alert is the metric that matters emotionally). Exactly
once per recipient per episode, enforced by a database claim, so converging
openers can never double-alert. The full pack follows via send-pack.

### Quiet-device alerts (automatic, owner only)
The answer to a thief who flips airplane mode or powers the phone off: a
sweep (every `QUIET_SWEEP_SECONDS`, default 60) emails the **owner** when an
enrolled phone with a live token stops checking in:

- **after a suspicious event** — a failed unlock or a boot left on the lock
  screen that no successful unlock has cleared, then `QUIET_AFTER_MINUTES`
  (default 30) of silence;
- **plain silence** — `SILENT_AFTER_HOURS` (default 24; `0` disables) with no
  contact at all.

At most one email per silence; it re-arms once the phone is heard from. Buddies
are not emailed: silence alone is too weak a signal. The email carries a
one-tap link (below) that marks the phone stolen, and THAT alerts them.
Stolen devices, and devices whose token was revoked (signed out), are not
watched.

### GET · POST /alert-actions/:token (public, browser)
The link in a quiet alert. `GET` renders a confirmation page and changes
nothing (mail scanners pre-fetch links); `POST` spends the single-use token
and opens an episode exactly like the owner's mark-stolen, so first alerts go
to the buddies. Valid for `ALERT_ACTION_TTL_HOURS` (default 72). Pages are HTML
and always `200`; a dead link gets a page saying so. Rate-limited (20/hour/IP).

## Buddies (people who receive alerts)

A buddy is a **Tambo user** the owner links to their account to receive theft
alerts. Consent is the buddy's own IN-APP accept - there is no emailed consent
link and no public unauthenticated surface. Only **accepted** buddies receive
alerts. States: `pending -> active | declined | revoked`.

### Owner side

**POST /buddies** 🔒 - invite by email.
```json
{ "email": "grace@example.com", "name": "Grace" }
```
`201` -> `{ buddy: { id, email, status: "pending" } }`. If that email is already
a Tambo user the link binds to them immediately (still pending their accept);
if not, it waits and binds when they sign up with that email. Always returns
`pending`, so the endpoint never reveals whether the address is registered.
Max 3 buddies; self-invite and duplicates refused; rate-limited (5/hour).

**GET /buddies** 🔒 - the owner's buddies with `status` and, once active, the
buddy's real name.

**DELETE /buddies/:id** 🔒 - revoke a buddy (frees a slot; the person can be
re-invited later).

### Buddy side

**GET /buddy-invites** 🔒 - invitations addressed to the caller (`from.name`,
`status`).

**POST /buddy-invites/:id/accept** · **/decline** 🔒 - the buddy's own answer.
Accepting activates the link (alerts now flow to them); atomically claimed, so
a concurrent double-tap records exactly one answer. Only the addressed user can
act - someone else's invitation is invisible and un-actionable.

Invitations to an email that is not yet a Tambo account **auto-bind** the moment
that person registers with it (email ownership proven by the signup OTP) and
then appear in their buddy-invites.

### People I protect (buddy side of an accepted link)

For the owner whose only phone is the stolen one: a buddy can report it.

**GET /protecting** 🔒 - owners who have the caller as an **active** buddy,
with their devices: `{ people: [{ owner: { id, name }, devices: [{ id, name,
make, deviceModel, status }] }] }`. No IMEIs, no check-in times.

**POST /protecting/devices/:id/report-stolen** 🔒 - `{ note? }`. Opens the
episode with `openedBy: "buddy"` and `reportedBy`, and first alerts go out as
for any other opener (the owner's email names the reporting buddy). `201`
opened / `200` already open. Only an ACTIVE link authorizes it; any other
device id is `404 device_not_found`, indistinguishable from an unknown one.
Rate-limited (5/hour).

## Error code index (additions)

| Code | Status |
|---|---|
| `buddy_limit_reached`, `buddy_is_self` | 400 |
| `missing_device_token`, `invalid_device_token` | 401 |
| `device_not_found`, `episode_not_found`, `buddy_not_found`, `invite_not_found` | 404 |
| `episode_open`, `buddy_exists` | 409 |
