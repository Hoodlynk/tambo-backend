# The November 2026 program

Owner brief, 2026-11-13: camera snapshot evidence; readiness for OEM
preinstall and a Transsion-style Zero-screen card; the Tambo app restructured
for an iOS launch; a UI pass; white-label scoping. Decisions taken in the
planning session:

- The app repo (`tabo`, Kevin's) is restructured **in place** to the
  `veriplus-mobile-app` shape; the naming is fixed carefully.
- Zero screen means **preinstall and a live card** on the Transsion Zero (-1)
  screen.
- White-label partners: OEMs, insurers/telcos, enterprises/NGOs (Device-Owner
  edition), BNPL phone sellers.
- **Backend foundations first**, one unit per session.

## Part A: backend sessions (this repo)

| # | Unit | Status | Done when |
|---|---|---|---|
| **B1** | Snapshot bursts | **Done 2026-11-13**, [f4-snapshots-scoping.md](f4-snapshots-scoping.md) | PHOTO burst contract, columns + index, `snapshotPolicy`, `GET /episodes/:id/snapshots` + frame bytes, PHOTO fixes in the trail, `snapshotSets` in the pack JSON and PDF, media limit 300/h, docs, spec + client regenerated. 23 new tests. |
| **B2** | Remote commands | next | `DeviceCommand` (snapshot \| locate \| ring) created by the owner, delivered as `pendingCommands` on ingest responses + `GET /evidence/commands` (device token) + FCM data message to a device-scoped push token (`deviceId` on `pushToken.model.ts`). Results arrive as envelopes with `commandId`. |
| **B3** | Partner tenancy, white-label config, launch handshake | | `Partner` (`code`, `type: oem\|insurer\|telco\|enterprise\|bnpl`, `brand`, `features`, `defaultPlan`, `alertRecipients`), `PartnerApiKey` (hashed + prefix, as `veri-plus-backend/src/middlewares/requireApiKey.ts`), admin CRUD, `User.partner?` / `Device.partner?`, `partnerCode` at register and enrol, `planSource: self\|partner`, `GET /api/v1/client/config?partner=&platform=` (min/recommended versions, feature flags, brand theme), `X-Client-Platform` / `X-Client-Version` recorded on sessions. |
| **B4** | OEM provisioning and device-first enrolment | | `POST /api/v1/partner/devices` (API key, bulk IMEI/serial → provisioning tokens), `POST /api/v1/devices/claim` (ingest token before any account), `POST /devices/:id/link`. `Device.user` optional with `Device.partner` required in its absence; episode open with no owner notifies partner recipients. Every `device.user` reader gets a test. Play Integrity on claim behind a flag. |
| **B5** | Partner webhooks and status cards | | HMAC-signed `episode.opened\|resolved`, `snapshot.received`, `device.claimed`; `GET /devices/:id/status-card` (owner) and `GET /evidence/status` (device token) for the widget / Zero-screen card. |

Each unit finishes per CLAUDE.md rule 10 and adds its row to
[roadmap.md](roadmap.md).

## Part B: the app repo, restructured in place (sessions run there)

Product name is **Tambo** (`tambo-app.com`, `app.json`, `strings.xml`, the
Xcode target). The repo folder is `tabo`, UI copy says "Tabo" in a dozen
strings, 35 components are named `Tabo*`, the Android `applicationId` is
`com.tamboapp`.

| # | Unit | Done when |
|---|---|---|
| **M0** | Naming | UI copy and token headers say Tambo; `Tabo*` components renamed to neutral names during the layout move; folder and repo renamed `tambo-mobile-app` under `Divergent-Networks-Limited` with Kevin's remote kept as a second remote (the VeriPlus precedent). **Owner decision X3:** keep `applicationId com.tamboapp` unless the app has never been published; changing it orphans installed builds. |
| **M1** | Process skeleton | Copied and adapted from `veriplus-mobile-app`: `CLAUDE.md`, `docs/{PRODUCTION-PLAN,DECISIONS,DEFERRED,NEXT-SESSION,BUILD-PROCESS,BACKEND-CONTRACT,DESIGN-SYSTEM,DEVICE,IOS-SIGNING,IOS-RELEASE-PLAN,PLAY-LISTING}.md`, `docs/screens/_TEMPLATE.md`, `scripts/doc`, `local-docs/` gitignored, `.nvmrc`, carets removed from `package.json`, `jest.setup.js`, GitHub Actions (tsc, eslint, jest), `.claude/settings.json` allowlist. |
| **M2** | Layout | `screens/`, `components/` → `src/screens`, `src/components`, `src/navigation`, `src/theme` (roles, both schemes), `src/net` (one base URL, `X-Client-*` headers, typed client from this repo's `openapi/openapi.json`), `src/auth`, `src/devices`, `src/evidence` (durable queue + uploader), `src/trail`, `src/notifications`. RTK Query stays. `PROJECT_OVERVIEW.md` / `CODING_STYLE.md` fold into the docs set. |
| **M3** | Native | Android: native evidence queue + WorkManager uploader ([f1-android-audit.md](f1-android-audit.md)), the snapshot capture service (camera FGS + overlay permission, hardware spike first), an App Widget carrying the status card (the Zero-screen adapter slots in front of it). iOS: Swift target with background location trail and push, no unlock detection; per-platform feature matrix in `BACKEND-CONTRACT.md`. |
| **M4** | iOS release readiness | `codemagic.yaml` workflows (`ios-device-debug`, `ios-testflight`), bundle id, signing, privacy manifest, background modes, App Store Connect record, review notes for an anti-theft app. This Mac runs macOS 12.7.6 and cannot build iOS; the cloud route is mandatory. |
| **M5** | UI pass | U1 design-system proposal as a rendered page for approval (roles, type scale, 4-pt grid, states, motion, platform conventions; keep the blue brand, retire what reads as artificial), U2 theme build, then one screen per session with approval. |
| **M6** | Features | Snapshot bursts, remote commands, trail cadence, familiar locations, buddies, pack viewer, status card, each against the finished contract. |

## Parts C and D

OEM / Zero-screen readiness: [oem-zero-screen-readiness.md](oem-zero-screen-readiness.md).
White-label scoping: [white-label-scoping.md](white-label-scoping.md).
