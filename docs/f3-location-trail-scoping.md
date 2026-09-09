# F3 scoping — location trail, static vs moving, familiar locations

**Status: scoping only — not yet built.** This captures the product intent
(from the 2026-09-09 sprint brief) and proposes the backend design, so build
can start without re-deriving it. What already exists is listed first so we
don't rebuild it.

## Already in place (F1/F-B)

- `TRAIL_POINT` evidence type: the device can already upload location fixes as
  hashed, tamper-evident envelopes; they attach to an open episode and are
  back-attached from the hour before it opened.
- A canonical location shape in payloads (`{ lat, lng, accuracyM }`) parsed
  leniently by [`src/services/evidenceLocation.ts`](../src/services/evidenceLocation.ts).
- "Last known location" in the first-alert email, and per-attempt locations in
  the owner's activity report.
- The client cue to start a trail: an ingest response with `episodeId` /
  `episodeOpened: true` (contract §2).

## The product requirements

1. **Static vs moving.** A phone under PIN attack that stays in one place
   (e.g. lost in a bar) reads differently from one moving across town (in a
   thief's pocket). The report must show:
   - *Static:* the single location where the attempts are happening.
   - *Moving:* the **location trail** — the path over time.
2. **Familiar locations.** The owner can register a short list of familiar
   places (home, work, …). Crucially: **familiar locations never relax the
   rules.** The threshold, the episode, the alerts all fire identically at
   home. Familiarity is *context for interpretation only*: it lets us say "the
   device is moving away from a familiar location" — the strongest cue to
   emphasise the trail and escalate reporting.

## Proposed backend design

### 1. Trail assembly (server-side, from existing data)

No new ingestion is needed — `TRAIL_POINT` envelopes are already the trail.
Add a read model:

- `GET /api/v1/episodes/:id/trail` (owner auth) →
  ordered `[{ at, lat, lng, accuracyM }]` from the episode's location-bearing
  envelopes (`TRAIL_POINT` + `UNLOCK_FAILED`), server-receipt ordered.
- **Movement classification** on the same response:
  `movement: "static" | "moving" | "unknown"`. Proposal: compute the maximum
  pairwise distance between fixes (haversine); `static` if every fix is within
  max(150 m, 2× worst accuracy) of the first fix, `moving` once any fix leaves
  that radius. `unknown` with < 2 usable fixes.
- The evidence-pack PDF gains a trail section: static ⇒ one location line +
  maps link; moving ⇒ first fix, latest fix, and the fix list.

### 2. Familiar locations

- Model: `FamiliarLocation { user, label ("home" | "work" | free text),
  lat, lng, radiusM (default ~200, owner-tunable, capped) }`, a handful per
  user (cap ~10).
- CRUD under `GET/POST/PATCH/DELETE /api/v1/familiar-locations` (owner auth).
- **Interpretation only** — used in exactly two read paths:
  - Trail/report annotation: each fix gains
    `familiar: null | { label, distanceM }`.
  - Episode summary + alert email escalation line: when the trail shows the
    device WAS within a familiar radius and later fixes leave it, the report
    says "left familiar location *home* at ~HH:MM, heading …". That sentence
    is the feature.
- **Explicitly out:** any code path where a familiar location suppresses,
  delays, or raises the threshold, the episode, or an alert. Enforced by
  keeping the familiar-location module out of `evidence.service` ingestion and
  `episode.service` entirely.

### 3. Client cadence (Android side, for the same feature)

- Below threshold: locations ride along on `UNLOCK_FAILED` payloads (already
  specified).
- Episode open (`episodeId` in an ingest response): start the trail fan-out —
  periodic `TRAIL_POINT` envelopes (e.g. every 1–5 min, battery-aware),
  uploaded opportunistically. The paid-plan "location pings every minute" is a
  client cadence choice; the backend contract is unchanged.

### Open questions (product)

- Trail cadence vs battery on free vs paid plans (ties into the Plans screen).
- Should "left a familiar location" trigger an *additional* email, or only
  enrich the existing alert/pack? (Recommend: enrich only, until we have
  delivery-channel dedup for follow-ups.)
- Familiar-location radius defaults and whether the app suggests them from
  history (privacy call — recommend owner-entered only, v1).
