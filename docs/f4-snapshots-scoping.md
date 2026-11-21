# F4 scoping — camera snapshot bursts

**Status: backend BUILT (2026-11-13, session B1 of
[program-2026-11.md](program-2026-11.md)). Android capture is the app's next
native unit; iOS never gets it.** API reference:
[evidence-api.md](evidence-api.md#camera-snapshot-bursts-f4).

## The product intent

When a stolen phone is being unlocked or tampered with, take several pictures
from the **front camera** (whoever is holding it) and the **back camera** (the
surroundings), tie them to the location and the moving trail, and deliver them
as one package: where the phone went, who had it, what was around them. The
owner brief (2026-11-13) calls this reconstructing the environment the phone
disappeared into.

## What was built (backend)

- **Contract.** A `PHOTO` envelope is one frame of a burst; its payload names
  `burstId`, `seq`, `count`, `camera`, `trigger`, `location`, `headingDeg`.
  Read leniently by `src/services/evidenceSnapshot.ts`; the payload string
  stays the hashed evidence. Legacy photos still ingest as a set of one.
- **Columns.** `burstId`, `camera`, `trigger`, `seq` are copied onto the
  envelope at ingest (read model only) with an `{ episode, burstId, seq }`
  index.
- **Trail.** Snapshot frames that carry a location are trail fixes with
  `source: "PHOTO"`, in the trail endpoint, the pack and the first-alert
  "last known location".
- **Read model.** `GET /episodes/:id/snapshots` groups frames per burst with
  the place and the familiar annotation; `GET
  /episodes/:id/snapshots/:envelopeId` streams one frame. Owner-only.
- **Pack.** `snapshotSets` in the JSON; a "Camera snapshots" section in the
  PDF, two embedded frames per set (front then back), eight at most, every
  frame hashed in the signed manifest.
- **Advice.** `snapshotPolicy` beside `trailCadenceSeconds` in ingest
  responses, from the entitlements matrix: free 3 frames per camera, 2 s
  apart, 5 bursts per episode; paid 20 bursts. Evidence is never refused
  (rule 4), nothing is deleted for exceeding it.
- **Limits.** Media uploads 300 per device per hour; 8 MB per frame unchanged.

## Decisions taken (defaults from the approved plan; change by editing one place)

| # | Decision | Where |
|---|---|---|
| X1 | 3 frames per camera, 2 s apart; 5 bursts free, 20 paid | `services/entitlements.ts` |
| X2 | Photos are owner-only in the app; buddies get them in the PDF only | `routes/v1/episode.routes.ts` |
| - | A photo without a location counts as a fixless check-in in `pointsWithoutFix` | `services/pack.service.ts` |

## The Android capture design (for the app repo's native unit)

The backend is tier-agnostic. What the phone can capture depends on the tier
it is installed into ([access-tiers-decision.md](access-tiers-decision.md)):

| Tier | Front/back capture on failed unlock | Notes |
|---|---|---|
| Consumer Play install | **Yes, with a user-granted permission.** `onPasswordFailed` (already in `MyDeviceAdminReceiver.kt`) starts a short foreground service with `foregroundServiceType="camera"`. On Android 11+ a service started from the background may use the camera only under an exemption; the one a consumer app can obtain is the owner granting **"Display over other apps"** (`SYSTEM_ALERT_WINDOW`) during onboarding. This is the path shipping anti-theft apps use. | Must be **proved on Transsion (HiOS/XOS) and Samsung** hardware before marketing says it: OEM battery managers kill services, and some builds refuse the camera while the keyguard is up. The spike is the first native unit. **2026-11-21:** the owner has a Samsung only, so the spike runs there; Transsion stays unproven and unclaimed until a phone or a partner build is tested. |
| OEM preinstall (system / priv-app) | Yes, clean | The Zero-screen edition. |
| Device-Owner (DPC) | Yes, clean | Enterprise / NGO fleets. |
| iOS | **No.** No failed-unlock callback, no background camera, ever. | The iOS edition ships trail, alerts, buddies, pack. The pack says which tier produced it. |

Capture rules the app should follow, all of which the backend already
supports:

1. One `burstId` per trigger event. Alternate front and back frames
   (`seq` 0 front, 1 back, 2 front...) so a burst cut short by the OS still
   holds one of each.
2. Attach the freshest location fix to **every** frame; the server pins the
   set to the first usable one.
3. Queue the envelope before the bytes; upload bytes opportunistically. The
   owner's app renders `hasMedia: false` frames as pending.
4. Respect `snapshotPolicy` and stop after `maxBurstsPerEpisode`; keep taking
   `failed_unlock` bursts regardless of `periodic` budget.
5. Never show a preview, never play the shutter sound where the platform
   allows silencing it, never write to the gallery.

## Legal note (for the DPIA, not the code)

Intruder photos are **third-party personal data**, and a face is
biometric-adjacent under the Kenya Data Protection Act. The backend keeps the
same retention as all evidence (90 days routine, 12 months on an episode),
reads are owner-only, and alert pushes never carry a photo. The lawful basis
(crime prevention / legitimate interest), the ODPC registration and the Terms
wording restricting publication of intruder photos are owner actions tracked
in [oem-zero-screen-readiness.md](oem-zero-screen-readiness.md).

## Owner-requested bursts (B2, built)

The owner can ask for a burst while an episode is open: a `snapshot` command
(optionally naming `cameras`), answered with PHOTO envelopes carrying
`trigger: "owner_request"` and the `commandId`. See
[commands-api.md](commands-api.md).
