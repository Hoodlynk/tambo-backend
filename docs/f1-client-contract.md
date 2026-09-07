# F1 client ↔ backend contract

**Audience:** the Android engineer building failed-unlock detection.
**Scope:** exactly what the phone sends and what it gets back. Nothing here is
Android code — it's the wire contract the device must speak. The detection
mechanism itself (device-admin `onPasswordFailed`) is yours to build; this is
where your evidence lands.

All values below are the live defaults, read from
[`src/config/config.ts`](../src/config/config.ts) and
[`src/validation/evidence.schema.ts`](../src/validation/evidence.schema.ts).
They are env-overridable server-side — treat them as current, not eternal.

---

## 0. The one-paragraph mental model

The phone **captures cheaply and locally**, then **uploads relentlessly** the
moment any connectivity appears. Each unit of evidence is an **envelope** with a
client-generated id that doubles as the idempotency key: re-sending is always
safe, the server de-dupes. A batch of `UNLOCK_FAILED` envelopes crossing the
device's threshold makes the **server** open a theft episode and fire the first
alert — the phone doesn't decide that, it just reports. The server's clock, not
the device's, is the authority for the threshold.

---

## 1. Authentication — the device token

Every evidence request authenticates as the **device**, never as the user:

```
X-Device-Token: <the ingest token>
```

The owner obtains it once at enrolment (`POST /api/v1/devices`, an authenticated
*user* call) and the response returns `ingestToken` **exactly once** — store it
on the phone (Keystore-wrapped, per the Evidence doc). It is scoped to evidence
ingest only: it keeps working even if the owner's login sessions are revoked (a
stolen phone must keep uploading), and it is useless for anything but ingest if
it leaks. If compromised, the owner rotates it (`POST /api/v1/devices/:id/token`)
and the old one dies instantly.

A missing token → `401 missing_device_token`. A wrong one → `401 invalid_device_token`.

---

## 2. Uploading evidence — `POST /api/v1/evidence`

```
POST /api/v1/evidence
X-Device-Token: <ingest token>
Content-Type: application/json
```

```json
{
  "envelopes": [
    {
      "id": "3f6cbb2e-4d1a-4c9e-a1b2-device-generated",
      "type": "UNLOCK_FAILED",
      "capturedAt": "2026-09-07T18:31:02.114Z",
      "payload": "{\"attemptNo\":3,\"method\":\"pin\"}",
      "sha256": "9b74c9897bac770ffc029102a200c5de..."
    }
  ]
}
```

### Envelope fields

| Field | Rule | Notes |
|---|---|---|
| `id` | 8–64 chars, `[A-Za-z0-9_-]` | Client-generated (a UUID is ideal). **This is the idempotency key.** Reuse it for retries of the *same* event; never reuse it for a different event. |
| `type` | one of the five below | `UNLOCK_FAILED`, `TRAIL_POINT`, `DEVICE_SNAPSHOT`, `STATUS`, `PHOTO` |
| `capturedAt` | ISO 8601 | The **device** clock. Recorded but never trusted for anything security-relevant. |
| `payload` | 1–8000 chars | The **exact string** you serialized. See the hashing rule below. |
| `sha256` | 64 hex chars | SHA-256 of the **exact bytes** of `payload`. |

Batch size: **1–100 envelopes** per request; JSON body up to **1 MB**.
Rate limit: **240 batches/hour per device** (`429 rate_limited` with
`Retry-After` if exceeded).

### The hashing rule — read this twice

The server verifies `sha256` against the **exact bytes** of the `payload`
string and **never re-parses or re-serializes** it. Two JSON strings that are
"equivalent" but differ by a space or key order are *different evidence*.

So on the device:

1. Serialize your payload object to a string **once**.
2. Hash **that exact string's UTF-8 bytes** → `sha256`.
3. Send **that exact string** as `payload`.

Do not hash an object and serialize separately, or let a JSON library re-emit
the string between hashing and sending. Hash the bytes you send.

### `UNLOCK_FAILED` payload

The server treats `payload` as opaque for `UNLOCK_FAILED` — it only counts the
envelopes. Put whatever helps the owner read the pack later; a suggested shape:

```json
{ "attemptNo": 3, "method": "pin" }
```

(`method` ∈ `pin | password | pattern` — biometric failures never reach you;
see the F1 deep-dive on the biometric blind spot.)

### The response — always `200`, read per-envelope

```json
{
  "results": [
    { "id": "3f6cbb2e-...", "status": "acked" },
    { "id": "9a01...",      "status": "duplicate" },
    { "id": "bad7...",      "status": "rejected", "reason": "hash_mismatch" }
  ],
  "episodeId": "665f0a...c31",
  "episodeOpened": true
}
```

Per-envelope `status`:

| status | what the phone does |
|---|---|
| `acked` | Mark the envelope **done** locally (`ACKED`). |
| `duplicate` | Also **done** — the server already had it. A safe retry landed. |
| `rejected` | Do **not** blindly retry. See `reason`. |

`reason` on `rejected`:

- `hash_mismatch` — your `sha256` doesn't match `payload`. A serialization bug
  on the device (see the hashing rule). Re-capture/re-serialize; don't loop.
- `id_conflict` — this `id` is already owned by a **different** device. You
  generated a colliding id. Regenerate the id.

`episodeId` / `episodeOpened`:

- `episodeId` present → the device currently has an **open theft episode**.
  This is the cue to start the location-trail fan-out (F3 Design C).
- `episodeOpened: true` → **this batch** just crossed the threshold and opened
  it. The server has already sent the first alert. Escalate: switch uploads to
  expedited, start the trail.
- Neither present → below threshold, no episode. Keep capturing normally.

### Idempotency & retry policy

- Retrying an envelope with the same `id` is always safe → `duplicate`.
- After a dropped connection mid-batch, just resend the whole batch; landed
  ones come back `duplicate`, missing ones `acked`.
- Order small before large: send `UNLOCK_FAILED` / `TRAIL_POINT` /
  `DEVICE_SNAPSHOT` (kilobytes) first, `PHOTO` metadata + bytes last.

---

## 3. Photos — `POST /api/v1/evidence/:envelopeId/media`

Only if F2's compliant foreground path ever captures one. First ingest a
`PHOTO` envelope (§2) whose `payload` describes the shot; then upload the bytes:

```
POST /api/v1/evidence/<the PHOTO envelope id>/media
X-Device-Token: <ingest token>
Content-Type: image/jpeg
X-Content-Sha256: <sha256 hex of the raw bytes>

<raw image bytes as the body>
```

Cap **8 MB**. Rate limit **60/hour per device**.

| Response | Meaning |
|---|---|
| `201 { envelopeId, bytes, stored: true }` | Stored. |
| `200 { ..., stored: false }` | Idempotent — these exact bytes were already attached. |
| `400 missing_content_hash` / `empty_media` / `hash_mismatch` | Header/body/hash problem. |
| `400 not_photo_envelope` | The envelope isn't a `PHOTO`. |
| `404 envelope_not_found` | Unknown id, or it belongs to another device. |
| `409 media_conflict` | This envelope already has **different** bytes. |
| `413 payload_too_large` | Over 8 MB. |

---

## 4. What the server does after the threshold (so you know what NOT to build)

You report; the **server** decides and acts. On an `UNLOCK_FAILED` stream
crossing the device's `failedUnlockThreshold` (default 3) within a
**10-minute window of server receipt time**:

1. Opens one theft episode (`openedBy: "device"`). A concurrent owner
   "mark stolen" converges on the **same** episode — never two.
2. Back-attaches the device's evidence from the previous **60 minutes** (the
   failed unlocks that led here) and extends its retention.
3. Sends the **first-alert email** to the owner and every accepted buddy.
4. Returns `episodeOpened: true` + `episodeId` to that ingest call.

The phone must **not** re-implement threshold logic, alerting, or episode
management. Counting on the device would be defeated by a wrong device clock;
the server counts by its own receipt time on purpose.

---

## 5. Owner-facing report (not called by the phone, but this is where the data shows up)

The owner's app reads `GET /api/v1/devices/:id/activity` (a *user* call, Bearer
JWT) to see "has anyone been trying my PIN?" — including below-threshold
attempts. It's fed entirely by the `UNLOCK_FAILED` envelopes the phone uploads:

```json
{ "activity": { "inWindow": 2, "threshold": 3, "toThreshold": 1,
                "windowMinutes": 10, "lastAttemptAt": "...", "recent": [ ... ] } }
```

So the value of that owner screen is exactly as good as the phone's upload
reliability. Upload promptly and this screen is live.

---

## 6. Minimal happy path, end to end

```
1. Owner enrols the device            → app stores ingestToken (once)
2. Thief fails the PIN 3x             → onPasswordFailed x3 (your code)
3. Phone queues 3 UNLOCK_FAILED       → persist locally FIRST
4. Connectivity appears              → POST /api/v1/evidence (batch of 3)
5. Server: threshold crossed         → 200 { episodeOpened: true, episodeId }
   ...and emails owner + buddies the first alert
6. Phone sees episodeOpened          → start trail fan-out, expedite uploads
7. Owner opens the app               → GET /devices/:id/activity shows it,
                                        and the signed pack is fetchable
```

## 7. Error-code quick reference (device-facing)

| Code | HTTP | |
|---|---|---|
| `missing_device_token` / `invalid_device_token` | 401 | bad/absent `X-Device-Token` |
| `validation_error` | 400 | malformed batch; see `details[]` |
| `missing_content_hash` / `empty_media` / `hash_mismatch` / `not_photo_envelope` | 400 | media upload |
| `envelope_not_found` | 404 | media for an unknown/foreign envelope |
| `media_conflict` | 409 | different bytes for an existing photo |
| `payload_too_large` | 413 | media over 8 MB |
| `rate_limited` | 429 | carries `Retry-After` |

Full reference: [`docs/evidence-api.md`](evidence-api.md).
