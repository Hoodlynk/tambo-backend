# Evidence Ingest API (F-B)

Base path `/api/v1/evidence`. **Authenticates as a DEVICE**, never a user:
every request carries `X-Device-Token: <ingest token from enrolment>`. A user
JWT is rejected here, and the ingest token is rejected everywhere else.

Design intent (Evidence doc): capture cheaply on the device, deliver
relentlessly, ACK idempotently - the phone retries until every envelope flips
to ACKED, and retries are always safe.

## POST /evidence

Batch of envelopes (1-100, JSON body up to 1 MB):

```json
{
  "envelopes": [
    {
      "id": "3f6cbb2e-...-device-generated",
      "type": "UNLOCK_FAILED",
      "capturedAt": "2026-09-04T18:31:02.114Z",
      "payload": "{\"attempt\":3}",
      "sha256": "<sha256 hex of the exact payload string>"
    }
  ]
}
```

- `id` — client-generated, the idempotency key. Retries after a half-acked
  batch are safe.
- `type` — `UNLOCK_FAILED | TRAIL_POINT | DEVICE_SNAPSHOT | STATUS | PHOTO`.
- `payload` — the EXACT string the device serialized (max 8000 chars). The
  server verifies `sha256` over those bytes and never re-canonicalizes:
  the (payload, sha256, receivedAt) triple is the item's tamper-evidence.
- `capturedAt` is the device's claim; the server stamps its own `receivedAt`,
  which is what the integrity manifest and threshold counting trust.

`200` always, with per-envelope results:

```json
{
  "results": [
    { "id": "...", "status": "acked" },
    { "id": "...", "status": "duplicate" },
    { "id": "...", "status": "rejected", "reason": "hash_mismatch" }
  ],
  "episodeId": "665f...",
  "episodeOpened": true
}
```

Client contract: flip `acked` and `duplicate` envelopes to ACKED locally;
re-capture-and-resend `rejected` ones. Rejection reasons: `hash_mismatch`
(payload does not match its hash) and `id_conflict` (id already claimed by a
different device).

### Episode attachment & the threshold trigger

- If the device has an OPEN theft episode, every stored envelope attaches to
  it (12-month retention instead of 90 days).
- If not, `UNLOCK_FAILED` envelopes count toward the device's
  `failedUnlockThreshold` (default 3, owner-tunable 1-10) within a 10-minute
  window **of server receipt time** - a lying device clock changes nothing.
  Crossing it auto-opens an episode (`openedBy: "device"`), converging with
  any concurrent owner mark-stolen on ONE episode, and back-attaches the
  device's evidence from the previous 60 minutes (the failed unlocks that led
  here), extending its retention.
- `episodeId` in the response tells the device a theft episode is live - the
  cue to start the trail fan-out (F1/F3 designs).

## POST /evidence/:envelopeId/media

Photo bytes for a `PHOTO` envelope (which must be ingested first).

- Body: the RAW bytes (`Content-Type: image/jpeg` etc.), max 8 MB.
- Header `X-Content-Sha256`: sha256 hex of the bytes; verified server-side.
- Storage: GridFS v1 behind a storage-agnostic seam (S3-compatible later).

`201` stored / `200` idempotent retry of identical bytes:

```json
{ "envelopeId": "...", "bytes": 183294, "stored": true }
```

| Code | Status | Meaning |
|---|---|---|
| `missing_content_hash`, `empty_media` | 400 | Header/body missing |
| `hash_mismatch` | 400 | Bytes do not match the declared hash |
| `not_photo_envelope` | 400 | Envelope is not a PHOTO |
| `envelope_not_found` | 404 | Unknown, or owned by another device |
| `media_conflict` | 409 | Envelope already has DIFFERENT media |
| `payload_too_large` | 413 | Over the 8 MB cap |

## Retention as code

Every envelope carries a computed `expiresAt` enforced by a TTL index:
**90 days** routine, **12 months** once attached to an episode (the periods
from the product docs). Media files carry the same window in GridFS metadata;
an hourly sweep deletes expired files, because the TTL monitor cannot cascade
into GridFS. The regulator asks to see the job - the index and the sweep ARE
the job.

## POST /evidence/heartbeat

The phone's periodic "still here" (every 15 minutes) when it has nothing to
upload. No body. `200 { ok: true, episodeId? }`. Every ingest batch also
counts as contact; together they stamp the device's `lastSeenAt`, which the
quiet-device watch reads (see devices-api.md).

## STATUS events the server reads

`STATUS` payloads are opaque evidence, except these shapes, which drive the
quiet-device watch's suspicion marker (applied in device order within a
batch; duplicates never re-apply):

| payload | effect |
|---|---|
| `{"event":"BOOT","locked":true}` | raises it (booted, still on the lock screen) |
| `{"event":"UNLOCK_SUCCEEDED"}` | clears it (the owner got in) |
| `{"event":"BOOT","locked":false}`, `ADMIN_ENABLED`, `ADMIN_DISABLED` | recorded only |

Every `UNLOCK_FAILED` also raises it. The phone sends `UNLOCK_SUCCEEDED` only
to close a suspicious run - ordinary unlocks are never uploaded.

## Rate limits

Keyed per device: 240 envelope batches/hour, 60 media uploads/hour, 30
heartbeats/hour.
