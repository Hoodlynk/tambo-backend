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

## Camera snapshot bursts (F4)

A `PHOTO` envelope is one **frame** of a **burst**: the several front- and
back-camera pictures the phone takes in one go while it is being unlocked or
tampered with. The payload is still an opaque hashed string; the server reads
it leniently (like locations) for these fields:

```json
{
  "burstId": "4b1e…-device-generated, shared by every frame of the burst",
  "seq": 0,
  "count": 3,
  "camera": "front",
  "trigger": "failed_unlock",
  "location": { "lat": -1.2921, "lng": 36.8219, "accuracyM": 12 },
  "headingDeg": 240
}
```

| Field | Meaning |
|---|---|
| `burstId` | 8-64 url-safe chars, one per capture. Frames with the same id group into one **set**. |
| `seq`, `count` | Position within the burst and how many frames it will hold. |
| `camera` | `front` (the person holding the phone) or `back` (the surroundings). |
| `trigger` | `failed_unlock` \| `episode_open` \| `owner_request` \| `periodic` \| `tamper`. |
| `location` | Where the burst was taken. Snapshot frames are **trail fixes** (source `PHOTO`). |
| `headingDeg` | Compass heading of the back camera, 0-359, optional. |

A payload without these fields is a legacy single photo: it still ingests and
reads as a set of one from an unknown camera. Send the frame envelope first,
then its bytes to `/evidence/:envelopeId/media`; the read model shows
`hasMedia: false` until the bytes land.

Design, platform limits and the legal note: [f4-snapshots-scoping.md](f4-snapshots-scoping.md).

### `snapshotPolicy` in the ingest response

While an episode is open the ingest response carries, beside
`trailCadenceSeconds`, the plan-tuned **advice** on how much to capture:

```json
{ "snapshotPolicy": { "framesPerCamera": 3, "intervalSeconds": 2, "maxBurstsPerEpisode": 5 } }
```

Advice only. Evidence is never refused because a device sent more
([plans-api.md](plans-api.md)).

### Reading the sets: `GET /api/v1/episodes/:id/snapshots` (Bearer, owner)

Frames grouped per burst in server-receipt order, each set pinned to the first
location any of its frames carried and annotated with the owner's familiar
place when inside one:

```json
{
  "snapshots": {
    "summary": { "bursts": 2, "frames": 5, "framesWithMedia": 4 },
    "bursts": [
      {
        "burstId": "4b1e…", "trigger": "failed_unlock",
        "at": "2026-11-13T08:00:04.120Z", "capturedAt": "2026-11-13T08:00:02.000Z",
        "location": { "lat": -1.2921, "lng": 36.8219, "accuracyM": 12, "mapsLink": "https://maps.google.com/?q=-1.2921,36.8219" },
        "familiar": { "label": "home", "distanceM": 44 },
        "expectedFrames": 3,
        "cameras": { "front": 2, "back": 1, "unknown": 0 },
        "frames": [
          { "envelopeId": "…", "seq": 0, "camera": "front", "receivedAt": "…", "capturedAt": "…",
            "sha256": "<media hash>", "bytes": 183294, "contentType": "image/jpeg",
            "hasMedia": true, "mediaPath": "/api/v1/episodes/<id>/snapshots/<envelopeId>" }
        ]
      }
    ]
  }
}
```

`GET /api/v1/episodes/:id/snapshots/:envelopeId` streams one frame's bytes
with its `Content-Type` and `X-Content-Sha256`. Scoped to the episode: an
envelope id alone never opens a photo. Errors: `episode_not_found`,
`snapshot_not_found`, `media_not_available` (bytes not uploaded yet), all 404.

**Owner-only.** Buddies see photos in the PDF pack they are emailed, never a
URL: intruder photos are third-party data and stay inside the owner's account.

The pack JSON carries the same grouping as `snapshotSets`; the PDF renders a
"Camera snapshots" section per set with the location link and up to two
embedded frames per set (front first, then back).

## Remote commands in the ingest reply (B2)

While an episode is open, the reply carries `pendingCommands`: the
outstanding owner commands (snapshot / locate / ring), oldest first, absent
when there are none. They are re-sent until answered, so dedup on `id`. Answer
with envelopes whose payload carries `commandId`. The full contract, plus
the poll (`GET /evidence/commands`) and the device push registration
(`POST /evidence/push-token`), is in [commands-api.md](commands-api.md).

## Retention as code

Every envelope carries a computed `expiresAt` enforced by a TTL index:
**90 days** routine, **12 months** once attached to an episode (the periods
from the product docs). Media files carry the same window in GridFS metadata;
an hourly sweep deletes expired files, because the TTL monitor cannot cascade
into GridFS. The regulator asks to see the job - the index and the sweep ARE
the job.

## The phone's status card (B5)

`GET /evidence/status` (device token) is what the phone's own widget shows:
`protected` or `unlinked` and the brand, **never** an open episode, the
failed-unlock count or a location. Contract:
[status-card-api.md](status-card-api.md).

## Rate limits

Keyed per device: 240 envelope batches/hour, 300 media uploads/hour (sized
for a pro episode's 20 bursts of 3 frames per camera, with retries), 360
command polls/hour, 30 push-token registrations/hour, 120 status-card
reads/hour.
