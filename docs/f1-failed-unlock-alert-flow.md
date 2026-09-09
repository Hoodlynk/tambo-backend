# F1: failed unlock → alert email — the whole pipeline

**Audience:** the Android engineer.
**Scope:** the end-to-end *process* — what happens from the moment someone
types a wrong PIN to the moment the owner and their buddies receive an email.
For the field-by-field wire contract (payload shapes, hashing rule, error
codes), see [f1-client-contract.md](./f1-client-contract.md); this doc is the
map, that one is the spec.

Everything below is **built and tested** on the backend
(`tests/unlockActivity.test.ts`, `tests/evidence.test.ts`). The only missing
piece of the pipeline is the client side: detecting the failed attempt on the
phone and uploading it.

---

## The pipeline at a glance

```
 Phone (yours to build)                 Backend (built)
┌──────────────────────┐   ┌─────────────────────────────────────────────┐
│ onPasswordFailed()   │   │                                             │
│   ↓ queue locally    │   │  POST /api/v1/evidence                      │
│ UNLOCK_FAILED        ├──►│    verify sha256 → store envelope           │
│ envelope(s)          │   │    count UNLOCK_FAILED in last 10 min       │
│ (X-Device-Token)     │   │    (SERVER receipt time)                    │
└──────────────────────┘   │      ↓ count ≥ device.failedUnlockThreshold │
                           │  open theft episode (device → "stolen")     │
                           │      ↓ fire-and-forget                      │
                           │  sendFirstAlert()                           │
                           │    ├─► owner's registered email             │
                           │    └─► every ACCEPTED buddy's email         │
                           │  (later: full evidence-pack PDF, same list) │
                           └─────────────────────────────────────────────┘
```

Key point for the client: **the phone never decides "this is theft" and never
sends email.** It reports raw failed attempts; the server does the counting,
the episode opening, and the alerting. One attempt = one envelope, uploaded
whenever connectivity allows.

---

## Step 1 — the phone reports failed attempts

**API: `POST /api/v1/evidence`** — the single ingest endpoint for all evidence,
failed unlocks included.

- Auth: `X-Device-Token: <ingest token>` (device credential, not a user
  session — it keeps working on a stolen phone even after the owner revokes
  their logins). Obtained once from `POST /api/v1/devices` at enrolment.
- Body: a batch of 1–100 envelopes. A failed unlock is an envelope with
  `type: "UNLOCK_FAILED"`, a client-generated id (the idempotency key — retries
  are always safe), `capturedAt` (device clock, ISO 8601), a `payload` string,
  and the `sha256` of that exact payload string.
- Response: always `200` with a per-envelope ack (`acked` / `duplicate` /
  `rejected`), plus `episodeId` and `episodeOpened: true` when *this batch*
  crossed the threshold.

Full request/response shapes, the hashing rule, and retry policy:
[f1-client-contract.md §2](./f1-client-contract.md).

Backend code:
- Route: `src/routes/v1/evidence.routes.ts`
- Ingest + threshold logic: `ingestBatch` and `maybeOpenByThreshold` in
  `src/services/evidence.service.ts`

---

## Step 2 — the server counts, using its own clock

After storing a batch that contained any `UNLOCK_FAILED`, the server counts
`UNLOCK_FAILED` envelopes for this device **received in the last
`thresholdWindowMinutes` (default 10), by server receipt time** — not
`capturedAt`. A tampered device clock cannot dodge or trigger the threshold.

When the count reaches `device.failedUnlockThreshold` (default **3**, owner-
configurable 1–10 via `PATCH /api/v1/devices/:id`), the server opens a **theft
episode**:

- The device's status flips to `stolen`.
- Evidence from the preceding 60 minutes (`backAttachMinutes`) is back-attached
  to the episode and its retention extended (365 days vs the routine 90).
- If an episode is already open (e.g. the owner hit *mark stolen* first), the
  two signals **converge on one episode** — a DB unique index referees the
  race. No duplicate episodes, no duplicate alerts.

Code: `maybeOpenByThreshold` / `backAttachRecent` in
`src/services/evidence.service.ts`; `openEpisode` in
`src/services/episode.service.ts`. Defaults in `src/config/config.ts`
(env-overridable: `THRESHOLD_WINDOW_MINUTES`, `BACK_ATTACH_MINUTES`, …).

---

## Step 3 — the first-alert email goes out

The moment an episode opens (whatever opened it — device threshold or owner
mark-stolen), `sendFirstAlert` in `src/services/delivery.service.ts` emails:

1. **The owner's registered email** (`User.email`).
2. **Every ACCEPTED buddy** — buddies who are pending, declined, or revoked get
   nothing (their in-app *accept* is the consent). Lookup:
   `activeBuddyEmails` in `src/services/buddy.service.ts`. Max 3 buddies.

Delivery properties worth knowing:

- **Exactly-once per recipient per episode.** Each send is claimed first via a
  unique-indexed `PackDelivery` row, so concurrent openers can't double-alert.
- **Fire-and-forget.** Mail-provider latency or outage never fails the ingest
  request; errors are logged server-side.
- The email names the device, the trigger ("repeated failed unlock attempts
  were detected"), the time, and first steps (block SIM, get an OB number).
- Later, the **full evidence-pack PDF** goes to the same recipient list
  (`sendFullPack`, same file). Pack sends are audited but *not* deduped —
  re-sending with more evidence is legitimate.

Mail transport is pluggable (`src/services/mailer/`): `MAIL_DRIVER=resend`
(real email, needs `RESEND_API_KEY`), `console` (stdout, dev), or `noop`.
**Nothing reaches a real inbox unless the server runs with the `resend`
driver configured.**

---

## Step 4 — below-threshold visibility (the activity report)

Attempts that *don't* reach the threshold trigger no email — by design. The
owner sees them instead through:

**API: `GET /api/v1/devices/:id/activity`** (owner auth, i.e. `Authorization`
bearer session — not the device token). Response:

```json
{
  "activity": {
    "inWindow": 2,
    "toThreshold": 1,
    "threshold": 3,
    "windowMinutes": 10,
    "lastAttemptAt": "2026-09-09T07:12:03.000Z",
    "recent": [
      { "capturedAt": "…", "receivedAt": "…" }
    ]
  }
}
```

This is the "has anyone been trying my PIN?" screen: the app (on the owner's
*other* device, or after recovery) polls it, no push involved. `recent` is the
last 20 failed attempts, newest first. Code: `unlockActivity` in
`src/services/evidence.service.ts`; route in `src/routes/v1/device.routes.ts`.

---

## What the Android client must and must not do

| Do | Don't |
|---|---|
| Capture each failed attempt (`DeviceAdminReceiver.onPasswordFailed`) and queue an `UNLOCK_FAILED` envelope locally | Don't count attempts or decide "stolen" on-device — the server owns the threshold |
| Upload the queue relentlessly on any connectivity, in batches, retrying with the same envelope ids | Don't generate a fresh id when retrying an upload — the id is the idempotency key, and a new id turns a retry into a second attempt in the count |
| Store the ingest token in the Keystore; use only `X-Device-Token` for evidence calls | Don't send any email/SMS from the phone — alerting is entirely server-side |
| Surface `episodeOpened: true` from the ingest response if you want immediate on-device UX | Don't call the activity endpoint with the device token — it's an owner-session endpoint |

---

## Quick file index (backend)

| Concern | File |
|---|---|
| Ingest route + rate limits | `src/routes/v1/evidence.routes.ts` |
| Envelope validation | `src/validation/evidence.schema.ts` |
| Ingest, threshold, activity report | `src/services/evidence.service.ts` |
| Episode open/converge | `src/services/episode.service.ts` |
| First alert + full pack emails | `src/services/delivery.service.ts` |
| Buddy eligibility | `src/services/buddy.service.ts` |
| Mail drivers | `src/services/mailer/` |
| Owner report route | `src/routes/v1/device.routes.ts` |
| Tunables (window, batch caps, retention) | `src/config/config.ts` |
| Tests proving the flow | `tests/evidence.test.ts`, `tests/unlockActivity.test.ts` |
