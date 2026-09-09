# Location trail & familiar locations API (F3)

**Audience:** the Android engineer.
**What it is:** the read model over evidence the device already uploads —
an episode's ordered location trail, classified **static vs moving**, plus
owner-registered **familiar locations** that annotate (never gate) reports.
Design rationale: [f3-location-trail-scoping.md](f3-location-trail-scoping.md).

The one rule carried through the code: **familiarity never relaxes anything.**
The threshold, the episode, and the alerts fire identically at home. Familiar
locations exist so a report can say *"the device left familiar location 'home'
at ~HH:MM"* — the strongest cue that the phone is in someone else's pocket.

All code: [`src/services/trail.service.ts`](../src/services/trail.service.ts),
[`src/services/familiarLocation.service.ts`](../src/services/familiarLocation.service.ts),
[`src/models/familiarLocation.model.ts`](../src/models/familiarLocation.model.ts).
Tests: [`tests/trail.test.ts`](../tests/trail.test.ts).

---

## 1. The trail — `GET /api/v1/episodes/:id/trail` (Bearer JWT, owner)

Assembled server-side from the episode's location-bearing envelopes
(`TRAIL_POINT` **and** `UNLOCK_FAILED`), ordered by server receipt time.
Envelopes without a usable fix are skipped, never an error.

```json
{
  "trail": {
    "movement": "moving",
    "points": [
      {
        "at": "2026-09-09T08:00:00.000Z",
        "source": "UNLOCK_FAILED",
        "lat": -1.2921, "lng": 36.8219, "accuracyM": 10,
        "familiar": { "label": "home", "distanceM": 44 }
      },
      {
        "at": "2026-09-09T08:04:00.000Z",
        "source": "TRAIL_POINT",
        "lat": -1.3005, "lng": 36.83,
        "familiar": null
      }
    ],
    "leftFamiliar": { "label": "home", "at": "2026-09-09T08:04:00.000Z" }
  }
}
```

- `movement`: `"static"` (a phone under attack in one place — lost in a bar),
  `"moving"` (in a thief's pocket), or `"unknown"` (fewer than 2 usable
  fixes). Static means every fix stays within **max(150 m, 2× worst reported
  accuracy)** of the first fix.
- `familiar` per point: the owner-registered place the fix is inside (nearest
  when radii overlap), or `null`.
- `leftFamiliar`: set only on a **moving** trail whose fixes were inside a
  familiar radius and later left it (the last such departure). Never set for
  static trails — GPS wobble at a radius boundary must not read as a
  departure.

Errors: `episode_not_found` (404, also for another user's episode).

## 2. Familiar locations — `/api/v1/familiar-locations` (Bearer JWT)

Owner-entered places, capped at **10** per account.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/` | — | `{ locations: [...] }` |
| POST | `/` | `{ label, lat, lng, radiusM? }` | 201 `{ location }` |
| PATCH | `/:id` | any subset of the above | 200 `{ location }` |
| DELETE | `/:id` | — | 204 |

- `label`: 1–40 chars, unique per user (`familiar_location_exists`, 409).
- `radiusM`: 50–2000, default **200**.
- Cap exceeded: `familiar_location_limit` (409).
- Unknown/foreign id: `familiar_location_not_found` (404).
- v1 is owner-entered only — the app never suggests places from history
  (privacy call, scoping doc).

## 3. Where familiarity surfaces (and where it never does)

Surfaces (interpretation only):
- Trail points and the departure line above.
- The evidence pack: `trail[].familiar`, plus `trailSummary:
  { movement, leftFamiliar }`; the PDF renders static as one location line
  and moving as first/latest fix + the full trail, with the departure
  sentence in bold.
- The first-alert email's last-known-location line gains
  `near familiar location "home" (~44m from its centre)` when it applies.

Never touches: `evidence.service` ingestion, the failed-unlock threshold,
`episode.service` opening/closing, or alert dispatch decisions. The familiar
module is deliberately not imported by any of those.

## 4. Client cadence (unchanged contract)

Below threshold, locations ride along on `UNLOCK_FAILED` payloads; once an
ingest response carries `episodeId` / `episodeOpened: true`, start uploading
periodic `TRAIL_POINT` envelopes (1–5 min, battery-aware) — see
[f1-client-contract.md](f1-client-contract.md). Payload shape for both:
`{ "location": { "lat", "lng", "accuracyM" } }` or the same fields top-level.
