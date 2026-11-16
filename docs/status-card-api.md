# The status card (B5)

The small "is my phone protected?" state that the Android App Widget (app
unit M3) renders, and that an OEM Zero-screen card will render through a thin
adapter ([oem-zero-screen-readiness.md](oem-zero-screen-readiness.md)).
There are two views of the same phone, and the difference is the point.

| | Owner's card | Phone's own card |
|---|---|---|
| Route | `GET /api/v1/devices/:id/status-card` | `GET /api/v1/evidence/status` |
| Auth | Bearer (the owner) | `X-Device-Token` (the phone) |
| Shows an open episode | yes | **never** |
| Failed-unlock count, location | yes | **never** |
| Rate limit | none beyond auth | 120 per hour per device |

Both answer with `Cache-Control: no-store` and carry `refreshAfterSeconds`
(1800): a widget refreshes on that cadence, not more often.

## Why the phone's own card is discreet

During an episode, whoever is holding the phone is presumably the thief. A
widget that says "stolen, tracking you, 2 of 3 attempts" is a widget that
gets the phone switched off or the SIM pulled before evidence arrives. The
phone's card therefore says only `protected` or `unlinked`, and the app
learns about an open episode the way it already does, from `episodeId` in
its ingest replies ([evidence-api.md](evidence-api.md)). The app must not
draw episode state on the widget from that knowledge either.

## The owner's card

```json
{
  "card": {
    "deviceId": "6650...",
    "deviceName": "My Tecno",
    "state": "protected | stolen | paused",
    "brand": {
      "displayName": "Tambo", "logoUrl": null,
      "colors": { "primary": "#1D28D6", "onPrimary": "#FFFFFF" },
      "supportUrl": "https://tambo-app.com", "supportEmail": null
    },
    "lastSeenAt": "2026-11-15T09:07:59.692Z",
    "unlockAttempts": { "inWindow": 1, "threshold": 3 },
    "episode": {
      "id": "6650...",
      "openedAt": "2026-11-15T09:05:00.000Z",
      "openedBy": "owner | device",
      "snapshotBursts": 3,
      "pendingCommands": 1,
      "lastLocation": { "lat": -1.2921, "lng": 36.8219, "accuracyM": 12, "at": "..." }
    },
    "refreshAfterSeconds": 1800,
    "generatedAt": "2026-11-15T09:08:00.000Z"
  }
}
```

- **`state`**: `stolen` while an episode is open; `paused` when the ingest
  token was revoked (`DELETE /devices/:id/token`), so the phone sends no
  evidence; otherwise `protected`.
- **`lastSeenAt`**: server receipt time of the phone's latest evidence, or
  `null` if it has sent none.
- **`unlockAttempts`**: failed unlocks inside the threshold window, as
  `GET /devices/:id/activity` counts them.
- **`episode`**: `null` with no open episode. `snapshotBursts` counts bursts
  (a legacy single photo is a burst of one). `pendingCommands` counts remote
  commands the phone has not answered yet ([commands-api.md](commands-api.md)).
- **`episode.lastLocation`** comes only from evidence received since the
  back-attach window before the episode opened (60 minutes by default). The
  card is not a tracker: with no episode there is no location at all, and a
  routine fix from hours earlier never appears.
- **`brand`** is the partner's when the phone belongs to one (a suspended
  partner keeps its brand), otherwise Tambo's. Same shape as
  `GET /client/config`.

Errors: `401` (Bearer), `404 device_not_found` for an unknown id or another
user's phone.

## The phone's own card

```json
{
  "card": {
    "deviceId": "6650...",
    "deviceName": "Tecno Spark 20",
    "state": "protected | unlinked",
    "brand": { "...": "as above" },
    "refreshAfterSeconds": 1800,
    "generatedAt": "2026-11-15T09:08:00.000Z"
  }
}
```

`unlinked` is a provisioned phone that claimed its ingest token but nobody
has signed in on yet ([provisioning-api.md](provisioning-api.md)); the widget
can invite the holder to sign in. Errors: `401 missing_device_token` /
`invalid_device_token`, `429 rate_limited`.
