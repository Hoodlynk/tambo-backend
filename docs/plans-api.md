# Plans & entitlements API — Free, Pro, Family

**Audience:** the client engineers and whoever handles support/billing.
**Status:** entitlements live; **billing rails not built yet** — plans are set
manually via the admin route until the Play Billing webhook (roadmap 3b)
lands, at which point the webhook flips the same fields.

All code: [`src/services/entitlements.ts`](../src/services/entitlements.ts)
(THE matrix — services never read `user.plan` directly),
[`src/services/plan.service.ts`](../src/services/plan.service.ts).
Tests: [`tests/plan.test.ts`](../tests/plan.test.ts).
Product scoping: [plans-scoping.md](plans-scoping.md).

## The matrix

| Entitlement | free | pro | family |
|---|---|---|---|
| `maxDevices` (enrolment) | 1 | 1 | 5 |
| `historyDays` (activity reads) | 7 | full* | full* |
| `trailCadenceSeconds` (advisory) | 300 | 60 | 60 |
| `pushAlerts` (real-time push) | — | ✓ | ✓ |
| `snapshotPolicy` (advisory, F4) | 3 frames/camera, 2 s apart, 5 bursts/episode | 3 / 2 s / 20 | 3 / 2 s / 20 |

\* "Full" is still bounded by evidence retention (90d routine / 365d episode) —
a safety/privacy policy, not a plan perk. The API reports it as
`historyDays: null`.

## Rules the enforcement never violates

1. **Evidence is never refused because of a plan.** Uploads from an enrolled
   device are always accepted; the cadence figure in ingest responses is
   *advice* to the phone, not a gate.
2. **A lapsed plan never bricks protection.** `planExpiresAt` in the past
   makes the account read as free (`effectivePlan`), which blocks *new*
   enrolments and trims reads — already-enrolled devices keep detecting,
   uploading, alerting (email), and producing packs.
3. **Episode evidence and packs are not history-clamped.** The 7-day free
   window applies to the owner's activity/event-history view only; an
   episode's trail and its insurer pack always cover the whole episode.
4. Push alerts are an entitlement of the **protected account** — the owner's
   plan covers pushes to their buddies. Email alerts always go out.

## Endpoints

```
GET /api/v1/plan                       (Bearer)
→ 200 { "plan": { "plan", "effectivePlan", "expiresAt", "source",
                  "entitlements": { maxDevices, historyDays, trailCadenceSeconds, pushAlerts,
                                    snapshotPolicy: { framesPerCamera, intervalSeconds, maxBurstsPerEpisode } } } }
```

Backs the Settings "Subscription" row. Branch on `effectivePlan`.

```
PATCH /api/v1/plan/:userId             (Bearer, admin role)
{ "plan": "free" | "pro" | "family", "expiresAt"?: "<ISO>", "source"?: "self" | "partner" }
→ 200 { plan }  |  403 forbidden  |  404 user_not_found
```

Downgrading to free (or omitting `expiresAt`) clears the expiry.

`source` records who pays and defaults to `self`. A signup under a partner
that has a `defaultPlan` gets `source: "partner"`
([partners-api.md](partners-api.md)). **The Play Billing webhook must leave
alone any account whose plan source is `partner` while that plan is in
force.**

## Client-visible effects elsewhere

- `POST /api/v1/devices` → **409 `device_limit`** when the allowance is used.
- `GET /devices/:id/activity` → `recent` trimmed to the plan window, and the
  response says so: `activity.historyDays` (null = full history).
- Evidence ingest responses carry `trailCadenceSeconds` while an episode is
  open — the phone should adopt it as its TRAIL_POINT interval.
- The same responses carry `snapshotPolicy` — how many camera frames to take
  per burst and how many bursts to bother sending. Advice: a device that sends
  more is never refused, and nothing is ever deleted for exceeding it.
