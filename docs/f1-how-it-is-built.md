# F1 (failed-unlock reporting) — how it is built in this repo

**Audience:** an engineer reading the backend to understand the feature.
**Scope:** the server-side half of F1 — receiving failed-unlock signals and
turning them into episodes, alerts, packs, and an owner report. The *detection*
half (Android device-admin `onPasswordFailed`) is a separate client codebase;
see [`docs/f1-client-contract.md`](f1-client-contract.md) for where the two meet.

---

## 1. What "F1" means on the backend

F1 in the product brief is "detect wrong-unlock attempts and report them." That
splits cleanly:

- **Detect** — the phone's job. A device-admin receiver catches a failed
  PIN/pattern and queues an `UNLOCK_FAILED` envelope. Not in this repo.
- **Report** — the backend's job, and it is fully built here:
  1. **Ingest** the failed-unlock evidence (verified, idempotent).
  2. **Decide** — count attempts and, at threshold, open a theft episode.
  3. **Alert** — email the owner and buddies the moment an episode opens.
  4. **Assemble** — put the unlock log into the signed evidence pack.
  5. **Surface** — let the owner read recent attempts on demand.

Each of those maps to concrete files below.

---

## 2. The data: one evidence envelope

Everything F1 stores is an `EvidenceEnvelope`
([`src/models/evidenceEnvelope.model.ts`](../src/models/evidenceEnvelope.model.ts)).
The design decisions that matter:

- **`envelopeId`** — the client-generated id, `unique`-indexed. It is the
  idempotency key: a retried upload collides on this index and is reported as a
  duplicate rather than stored twice.
- **Two clocks, kept apart.** `capturedAt` is the device's claim; `receivedAt`
  is the server's stamp. Only `receivedAt` is trusted — the threshold counts by
  it, so a thief backdating the phone's clock changes nothing.
- **`payload` + `sha256`** — the exact string the device sent and its hash,
  verified at receipt. From that moment the `(payload, sha256, receivedAt)`
  triple is the item's tamper-evidence, which the pack's signed manifest builds
  on.
- **`expiresAt`** — a TTL index. Routine evidence self-deletes at 90 days;
  attaching to an episode extends it to 12 months. Retention is a database job,
  not a policy paragraph.
- Two secondary indexes serve F1 directly: `{ device, type, receivedAt }` for
  the threshold count and the owner report, `{ episode, receivedAt }` for pack
  assembly.

---

## 3. The flow, file by file

```
POST /api/v1/evidence                        (device-authenticated)
  │  routes/v1/evidence.routes.ts   → requireDeviceToken, parse, rate-limit
  │  controllers/evidence.controller.ts → ingest()
  ▼
services/evidence.service.ts → ingestBatch()
  ├─ verify each sha256 against the exact payload bytes ......... reject on mismatch
  ├─ create envelope (idempotent on envelopeId) ................ acked / duplicate
  ├─ attach to the open episode if one exists
  └─ if an UNLOCK_FAILED landed and no episode is open:
        maybeOpenByThreshold(device)
          ├─ count UNLOCK_FAILED in the last 10 min BY receivedAt
          ├─ if count >= device.failedUnlockThreshold:
          │     episodeService.openEpisode(device, 'device')
          │        └─ (first alert fires here, see §5)
          │     backAttachRecent()  → pull in the last 60 min, extend retention
          └─ return { episodeId, episodeOpened: true }
```

### 3.1 Ingest & integrity — `services/evidence.service.ts` → `ingestBatch`

For each envelope: hash-verify, then `create`. A duplicate-key error on
`envelopeId` is translated — same device → `duplicate` (a safe retry), a
different device → `rejected: id_conflict`. Anything that isn't a duplicate-key
error propagates as a real failure. The response is a per-envelope ACK list so
the phone can flip `acked`/`duplicate` envelopes to done and retry only
rejections.

### 3.2 The threshold trigger — `maybeOpenByThreshold`

Only runs when a batch contained at least one `UNLOCK_FAILED` and no episode is
already open. It counts `UNLOCK_FAILED` for the device within
`config.evidence.thresholdWindowMinutes` (default **10**) **by `receivedAt`**,
and if that meets `device.failedUnlockThreshold` (default **3**, owner-tunable
1–10) it opens an episode via the shared F-A seam. Counting by server time is
the deliberate defense against a lying device clock.

### 3.3 Convergence — `services/episode.service.ts` → `openEpisode`

The owner's "mark stolen" and the device's threshold can fire within seconds of
the same theft. `openEpisode` converges them onto **one** episode: a partial
unique index (`device` where `status: 'open'`) makes the database the referee,
and the loser of the race is handed the winner's episode. So F1 never produces a
second, duplicate incident.

### 3.4 Back-attach — `backAttachRecent`

When the threshold opens an episode, the failed unlocks that *led* to it were
already stored as routine evidence. `backAttachRecent` pulls the device's
envelopes from the previous `config.evidence.backAttachMinutes` (default **60**)
into the episode and extends their retention to 12 months — so the incident
record includes the run-up, not just what arrived after.

---

## 4. The owner report — `GET /api/v1/devices/:id/activity`

The "has anyone been trying my PIN?" screen.
[`evidence.service.ts` → `unlockActivity`](../src/services/evidence.service.ts)
reads `UNLOCK_FAILED` by `receivedAt` and returns:

```json
{ "activity": { "inWindow": 2, "threshold": 3, "toThreshold": 1,
                "windowMinutes": 10, "lastAttemptAt": "...", "recent": [...] } }
```

Its reason to exist: before it, an owner could see unlock attempts **only**
inside a pack, and only **after** an episode had opened. Below-threshold
activity — someone trying twice and giving up — was invisible. This surfaces it,
owner-scoped (a foreign device id 404s exactly like a missing one), counted by
the same server-time authority the threshold uses. Route in
[`routes/v1/device.routes.ts`](../src/routes/v1/device.routes.ts), handler
`device.controller.ts → activity`.

---

## 5. Alerting & the pack (where F1 evidence ends up)

- **First alert** — `services/delivery.service.ts → sendFirstAlert`, invoked
  from `openEpisode` the instant an episode opens (fire-and-forget, so alerting
  can never slow or fail detection). Deduped per recipient by a database claim,
  so converging triggers can't double-alert. Details:
  [`docs/devices-api.md`](devices-api.md).
- **The pack** — `services/pack.service.ts` reads every envelope in the episode
  and renders the **Failed unlock attempts** section (each attempt's device and
  server times) into the JSON and the PDF, covered by the Ed25519-signed
  integrity manifest. Details: [`docs/evidence-api.md`](evidence-api.md).

---

## 6. Configuration

All F1 knobs live in [`src/config/config.ts`](../src/config/config.ts) under
`evidence` and on the device model, env-overridable:

| Setting | Default | Meaning |
|---|---|---|
| `Device.failedUnlockThreshold` | 3 | Attempts that auto-open an episode (owner-tunable 1–10) |
| `THRESHOLD_WINDOW_MINUTES` | 10 | Counting window (server receipt time) |
| `BACK_ATTACH_MINUTES` | 60 | Run-up pulled into a new episode |
| `EVIDENCE_RETENTION_ROUTINE_DAYS` | 90 | Routine evidence TTL |
| `EVIDENCE_RETENTION_EPISODE_DAYS` | 365 | Episode evidence TTL |
| `EVIDENCE_MAX_BATCH` | 100 | Envelopes per ingest request |
| ingest rate limit | 240/hr/device | In `config/rateLimits.ts` |

---

## 7. Tests — where the behavior is pinned

Run against a real in-memory MongoDB, not mocks:

- [`tests/evidence.test.ts`](../tests/evidence.test.ts) — hash verification,
  idempotent retries, cross-device id conflict, the threshold auto-open,
  back-attach, and the server-clock-vs-device-clock guarantee.
- [`tests/unlockActivity.test.ts`](../tests/unlockActivity.test.ts) — the owner
  report: below-threshold visibility, newest-first ordering, `UNLOCK_FAILED`-only
  counting, `toThreshold` clamping, ownership isolation.
- [`tests/episodes.test.ts`](../tests/episodes.test.ts) — episode convergence
  (never two open episodes for one device).
- [`tests/pack.test.ts`](../tests/pack.test.ts) — the unlock log in the signed
  pack.

---

## 8. The boundary, restated

This repo is the **reporting** half and is complete: ingest → threshold →
episode → alert → pack → owner report, all tested. The **detection** half is
Android device-admin work in a separate codebase. When that client sends
`UNLOCK_FAILED` envelopes per [`docs/f1-client-contract.md`](f1-client-contract.md),
every stage above runs automatically — no further backend work is required for
F1 to function end to end.
