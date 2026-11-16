# OEM preinstall and Zero-screen readiness

Owner intent (2026-11-13): Tambo preinstalled on manufacturer phones **and**
shown as a live card on the Transsion-style Zero (-1) screen, ready to
integrate the day a manufacturer says yes. This page separates what the code
can prepare now from what only the owner can obtain.

## What the code prepares (tracked in [program-2026-11.md](program-2026-11.md))

| Need | Backend | App |
|---|---|---|
| A partner the fleet belongs to | B3 `Partner` + API keys | `partnerCode` in the build flavour |
| Phones that protect before anyone signs in | B4 provisioning tokens + `POST /devices/claim` (ingest token with no account) + `POST /devices/:id/link` later | Boot receiver already exists; deferred sign-in; evidence queue works offline |
| Brand, legal docs, support links per partner | B3 `GET /client/config` brand theme | Runtime theme from config; flavours only for icon, name, `applicationId` |
| The card's data | B5 `GET /evidence/status` (device token) and `GET /devices/:id/status-card` (owner) | M3 App Widget rendering the same state; the OEM card SDK is a thin adapter over it |
| The OEM's systems hearing about thefts | B5 HMAC webhooks | n/a |
| A build that survives as a system app | n/a | No Play dependency on the hot path, small background footprint, no auto-start tricks, works with the camera FGS exemptions a system app has |
| Depth of capture | tier-agnostic already | [access-tiers-decision.md](access-tiers-decision.md): preinstall is the tier where failed-unlock capture and snapshots are clean |

## What the owner must obtain before an integration can start

1. **A manufacturer partner contact**, and from them: the Zero-screen card SDK
   or feed API and its review process, the preinstall technical requirements
   (APK signing, allowed permissions, size, background policy), and whether
   the app ships as a system app, a privileged app, or a Device Owner. The
   card API is partner-only; there is nothing public to code against, which
   is why the App Widget is built first as the adapter target.
2. **Which tier the preinstall runs in**, since it fixes the capability
   ceiling and the marketing claims.
3. **Data processing agreement** with the manufacturer covering evidence,
   intruder photos and the partner webhooks.
4. **DPIA and ODPC registration** covering intruder photos (third-party
   data), location trails and partner data sharing.
5. **Hosting region** (still open since 2026-09; it blocks the DPIA
   cross-border section).
6. A **first design partner** to build the card against, even a small one.

## Readiness checklist (tick as each lands)

- [x] B3 partner tenancy and client config
- [x] B4 device-first enrolment and provisioning API ([provisioning-api.md](provisioning-api.md))
- [x] B5 status endpoints and webhooks ([webhooks-api.md](webhooks-api.md), [status-card-api.md](status-card-api.md))
- [ ] M3 App Widget with the status card
- [ ] A system-app build flavour that installs and boots on a factory image
- [ ] Partner integration guide (API key issue, provisioning, webhooks, config)
- [ ] Owner items 1 to 6 above
