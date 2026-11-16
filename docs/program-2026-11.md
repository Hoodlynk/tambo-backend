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
| **B2** | Remote commands | **Done 2026-11-13**, [commands-api.md](commands-api.md) | `DeviceCommand` (snapshot \| locate \| ring) created by the owner, delivered as `pendingCommands` on ingest responses + `GET /evidence/commands` (device token) + FCM data message to a device-scoped push token (`deviceId` on `pushToken.model.ts`). Results arrive as envelopes with `commandId`. |
| **B3** | Partner tenancy, white-label config, launch handshake | **Done 2026-11-13**, [partners-api.md](partners-api.md) | `Partner` (`code`, `type: oem\|insurer\|telco\|enterprise\|bnpl`, `brand`, `features`, `defaultPlan`, `alertRecipients`), `PartnerApiKey` (hashed + prefix, as `veri-plus-backend/src/middlewares/requireApiKey.ts`), admin CRUD, `User.partner?` / `Device.partner?`, `partnerCode` at register and enrol, `planSource: self\|partner`, `GET /api/v1/client/config?partner=&platform=` (min/recommended versions, feature flags, brand theme), `X-Client-Platform` / `X-Client-Version` recorded on sessions. |
| **B4** | OEM provisioning and device-first enrolment | **Done 2026-11-13**, [provisioning-api.md](provisioning-api.md) | `POST /api/v1/partner/devices` (API key, bulk IMEI/serial → provisioning tokens), `POST /api/v1/devices/claim` (ingest token before any account), `POST /devices/:id/link`. `Device.user` optional with `Device.partner` required in its absence; episode open with no owner notifies partner recipients. Every `device.user` reader gets a test. Play Integrity on claim behind a flag. |
| **B5** | Partner webhooks and status cards | **Done 2026-11-15**, [webhooks-api.md](webhooks-api.md), [status-card-api.md](status-card-api.md) | HMAC-signed `episode.opened\|resolved`, `snapshot.received`, `device.claimed`; `GET /devices/:id/status-card` (owner) and `GET /evidence/status` (device token) for the widget / Zero-screen card. |

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

## Model per session (assigned 2026-11-16)

Owner rule: every session names its Claude model before it starts, so no
session guesses and none pays for capability it does not use. Set it with
`/model` at the top of the session; the effort level goes with it.

API list prices per million tokens (input / output), 2026-11: Fable 5.2
$8 / $40, Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50.
Fable costs twice Opus and four times Sonnet for the same tokens.

**How the tier is chosen.** By what a mistake costs and how well the work is
specified, not by how large the change is:

- **Fable 5.2, effort high**: a wrong answer is expensive to find or to
  undo, and no test catches it (merges across security code, native work
  that cannot be run on this Mac, pre-launch audits).
- **Opus 5.5, effort high** (medium where marked): security, money or
  data-ownership logic with a written design and a test suite to check it.
- **Sonnet 5.5, effort medium** (high where marked): well-specified work
  behind an existing seam or pattern; renames, docs, config.
- **Haiku 5.5**: search and read-only subagents inside any session; never
  the session model for code changes here.

**Escalation rule.** If a session fails the gates twice on the same problem,
or starts re-deriving the design, stop and restart it one tier up. Never
step down mid-session: the prompt cache is per model.

### Backend (this repo)

| Session | Model | Effort | Why |
|---|---|---|---|
| Commit split of B1 to B5 into a series | Opus 5.5 | medium | Staged and unstaged hunks of the same files must land in the right commit; each commit should pass the gates |
| Merge Kevin's two remote commits (watchdog, alert actions, OTP) | **Fable 5.2** | high | Conflicts in episode, evidence, OTP and device code; two OTP implementations to reconcile; the suite only covers what each side tested |
| Play Billing RTDN webhook (3b) | Opus 5.5 | high | Money and an external contract; must skip `planSource: partner` |
| Play Integrity verifier | Opus 5.5 | high | Security check, small surface, seam exists |
| Phone / SMS OTP | Opus 5.5 | high | Auth change; design is in sms-otp-scoping.md; SMS-pumping defences |
| Account deletion and data export | Opus 5.5 | high | Cascades over every model, irreversible, legal weight |
| Episode archival on device removal | Opus 5.5 | medium | Needs one design choice, then moderate code |
| Unlink / transfer of a partner phone | Opus 5.5 | high | Moves ownership of episodes and evidence |
| Webhook secrets encrypted at rest | Opus 5.5 | medium | Key handling; waits on the hosting decision |
| Per-partner legal documents | Opus 5.5 | medium | Touches the enrolment legal gate |
| 2FA (TOTP) | Opus 5.5 | medium | Auth, but a standard algorithm and a low priority |
| Webhook auto-disable and manual redeliver | Sonnet 5.5 | high | Extends a tested service |
| Server-side partner feature flags | Sonnet 5.5 | high | One middleware pattern applied across routes |
| Partner-plan expiry | Sonnet 5.5 | medium | Follows `planExpiresAt` |
| S3-compatible media driver | Sonnet 5.5 | high | Drop-in behind `media.storage.ts` |
| Dockerfile, hosting config, deploy runbook | Sonnet 5.5 | high | Conventional; reviewed in the audit below |
| Seeded demo partner, partner integration guide, doc upkeep | Sonnet 5.5 | medium | Writing and seed data |
| Pre-launch audit and security review | **Fable 5.2** | high | Finding what the tests do not; run once, before real users |

### App repo (M0 to M6)

| Session | Model | Effort | Why |
|---|---|---|---|
| M0 Naming | Sonnet 5.5 | high | Mechanical renames; the `applicationId` question is the owner's, not the model's |
| M1 Process skeleton | Sonnet 5.5 | medium | Copy and adapt from `veriplus-mobile-app` |
| M2 Layout move and typed client | Opus 5.5 | medium | Whole-app restructure with a thin test net |
| M3 Android evidence queue + WorkManager uploader | Opus 5.5 | high | Durability and retry logic, specified in f1-android-audit.md |
| M3 Android snapshot capture (camera FGS, overlay permission) | **Fable 5.2** | high | Platform restrictions, OEM differences, hardware spike |
| M3 Android App Widget (status card) | Sonnet 5.5 | high | Standard widget against a finished endpoint |
| M3 iOS Swift target (background location, push) | **Fable 5.2** | high | Cannot be built on this Mac; every wrong guess is a cloud build |
| M4 iOS release readiness (Codemagic, signing, privacy manifest) | Opus 5.5 | medium | VeriPlus precedent to copy; failed builds cost time |
| M5 U1 design-system proposal | Opus 5.5 | high | Design judgment, one page for approval |
| M5 U2 theme build, then one screen per session | Sonnet 5.5 | high | Applies the approved system; Opus for a screen that fails twice |
| M6 Features against the finished contract | Sonnet 5.5 | high | Opus 5.5 for remote commands and anything touching the evidence queue |

Copy the app-repo table into that repo's `docs/NEXT-SESSION.md` at M1.

## Parts C and D

OEM / Zero-screen readiness: [oem-zero-screen-readiness.md](oem-zero-screen-readiness.md).
White-label scoping: [white-label-scoping.md](white-label-scoping.md).
