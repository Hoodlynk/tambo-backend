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
| **M0** | Naming | **Code done 2026-11-16, committed locally in `tabo` as c7bd038 (not pushed); repo/folder rename and new remote wait on the owner (see the outcome below).** UI copy and token headers say Tambo; `Tabo*` components renamed to neutral names during the layout move; folder and repo renamed `tambo-mobile-app` under `Divergent-Networks-Limited` with Kevin's remote kept as a second remote (the VeriPlus precedent). **Owner decision X3:** keep `applicationId com.tamboapp` unless the app has never been published; changing it orphans installed builds. |
| **M1** | Process skeleton | **Done 2026-11-16, committed locally in `tabo` as 3b22fb8 (not pushed).** Lean adaptation, not a copy: the VeriPlus `DECISIONS.md` alone is 16k lines of its own history. Jest was broken on Kevin's `main` and now passes (ESM transform allowlist, `lucide-react-native` mapped to CJS, native modules mocked). `tsc`, `eslint`, `jest` clean. Copied and adapted from `veriplus-mobile-app`: `CLAUDE.md`, `docs/{PRODUCTION-PLAN,DECISIONS,DEFERRED,NEXT-SESSION,BUILD-PROCESS,BACKEND-CONTRACT,DESIGN-SYSTEM,DEVICE,IOS-SIGNING,IOS-RELEASE-PLAN,PLAY-LISTING}.md`, `docs/screens/_TEMPLATE.md`, `scripts/doc`, `local-docs/` gitignored, `.nvmrc`, carets removed from `package.json`, `jest.setup.js`, GitHub Actions (tsc, eslint, jest), `.claude/settings.json` allowlist. |
| **M2** | Layout | **Done 2026-11-16, committed locally in `tabo` (bcdbb08 seam tests, cfb4c2e move, 8e49e91 net, 90c2190 docs; not pushed).** Everything under `src/` by domain (`auth`, `devices`, `buddies`, `evidence`, `net`, `store`, `navigation`), D5. Typed client = this repo's `clients/typescript/tambo-api.d.ts` vendored as `src/net/schema.d.ts` by `scripts/sync-api-types`; no package added. `X-Client-*` on every JS request, `APP_VERSION` held to the native versions by a test. Tests 1 → 22, plus `net.live.test.ts` run green against this backend on an in-memory Mongo. Found: the app never sends `X-Refresh-Token`, so `GET /auth/sessions` never marks `current` (app DEFERRED 2.6). Theme roles/schemes moved to M5. Kevin's two docs folded into `docs/ARCHITECTURE.md`, `docs/CODING-STYLE.md`. |
| **M3** | Native | Android: native evidence queue + WorkManager uploader ([f1-android-audit.md](f1-android-audit.md)), the snapshot capture service (camera FGS + overlay permission, hardware spike first), an App Widget carrying the status card (the Zero-screen adapter slots in front of it). iOS: Swift target with background location trail and push, no unlock detection; per-platform feature matrix in `BACKEND-CONTRACT.md`. |
| **M4** | iOS release readiness | `codemagic.yaml` workflows (`ios-device-debug`, `ios-testflight`), bundle id, signing, privacy manifest, background modes, App Store Connect record, review notes for an anti-theft app. This Mac runs macOS 12.7.6 and cannot build iOS; the cloud route is mandatory. |
| **M5** | UI pass | U1 design-system proposal as a rendered page for approval (roles, type scale, 4-pt grid, states, motion, platform conventions; keep the blue brand, retire what reads as artificial), U2 theme build, then one screen per session with approval. |
| **M6** | Features | Snapshot bursts, remote commands, trail cadence, familiar locations, buddies, pack viewer, status card, each against the finished contract. |

**M0 outcome (2026-11-16, Sonnet 5.5).** Done in `tabo` on top of Kevin's
latest `origin/main` (2d8b7d0). Seven `Tabo*` atoms became `App*`
(`AppText`, `AppButton`, `AppIcon`, `AppCard`, `AppBadge`, `AppPressable`,
`AppInput`) and `TaboLogo` became `BrandMark` (the VeriPlus name). Visible
copy, file headers and the `--tabo-*` CSS tokens now say Tambo, and the ten
`assets/icons/tabo-*` files are `tambo-*` with their labels fixed. `tsc` and
`eslint` are clean. Left alone on purpose: the `@tabo/*` AsyncStorage keys
(renaming signs installed users out; commented in `token.ts`) and
`applicationId com.tamboapp` (already Tambo; X3 stays "keep").

Waiting on the owner:

- **The wordmark and lockup artwork spells "Tabo"** (outlined glyphs, not
  text) in `tambo-wordmark-*` and `tambo-lockup-*`. The screens in use today
  show only the lens `logo.png`, so nothing visible is wrong yet, but the SVGs
  need redrawing before they are used. This is brand artwork, not a code
  change.
- **Folder and repo rename** (`tambo-mobile-app` under
  `Divergent-Networks-Limited`, Kevin's remote kept as a second remote) is
  outward-facing and Kevin pushes to `origin/main`: not done. Needs the
  owner's go-ahead, and Kevin told first.
- **Release signing secrets are committed**: `android/gradle.properties` holds
  the upload keystore and key password `tabo123`. Move them out of the repo in
  M1/M4, and treat that password as burned if that key is the Play upload key.
- `android/.artifacts/` (an agent planning file) is tracked; remove in M1.
- `npm test` fails on unmodified `main` too (ESM transform of
  `@react-navigation/native`); `jest.setup.js` in M1 fixes it.

## Owner decisions and the revised run order (2026-11-21)

A status review on 2026-11-21 found the backend complete for launch and the
app the whole critical path. It also found **production behind `main`**:
`api.tambo-app.com` answers `/api/health` but 404s `/api/v1/plan`,
`/api/v1/client/config` and `/api/openapi.json`, and this repo has no
Dockerfile or deploy runbook.

Owner answers, same day:

| Topic | Answer |
|---|---|
| Test phones | **Samsung only.** The snapshot spike runs on Samsung; Transsion behaviour is unproven and no claim is made for it until a Transsion phone or a partner build is tested. |
| Hosting region, DPIA, ODPC registration | In place (owner). No longer a gate for snapshots. |
| Firebase project and service account | Owner is asking Tom; push work waits on the answer. |
| Play listing | **The app is published and live.** X3 is settled: `applicationId com.tamboapp` stays. Live users also make the committed upload-key password (app DEFERRED 1.3) and backward compatibility on deploy real concerns. |
| Free-plan alerts | Confirmed: push alerts stay a paid entitlement; free accounts are alerted by email. |
| Wordmark artwork | Redrawn in `assets/icons` of the app repo (an "m" drawn to match the existing glyphs) and **approved by the owner**. |
| Repo rename (R1) | **Done.** The app repo is `../tambo-mobile-app`, `origin` is `Divergent-Networks-Limited/tambo-mobile-app` (private), and Kevin's `kevinmoturi/tabo` is the remote `kevin`. Where this file says `tabo` above, read `tambo-mobile-app`. |

Revised order. It replaces the M3 to M6 sequence above where they disagree:
iOS moves after the Android release, M6 splits into the core theft journey
(before release) and partner features (after a partner is named), and deploy
and account deletion move up.

| # | Step | Model / effort | Notes |
|---|---|---|---|
| 1 | ~~Push the app repo~~ | none | **Done 2026-11-21**: renamed, M0 to M2 plus the artwork pushed to the organisation repo. Kevin's remote was not pushed to |
| 2 | Deploy `main`: Dockerfile, hosting config, runbook | Sonnet 5.5 / high | **Built 2026-11-21, the owner runs the deploy** ([deploy.md](deploy.md)). The published-build check found two breaks (unverified login shape, legal gate on enrolment) and closed them for header-less builds; see the roadmap entry. Image not yet built with Docker |
| 3 | M3a evidence queue, heartbeat, `installId`, boot events | Opus 5.5 / high | Baton in `../tambo-mobile-app/docs/NEXT-SESSION.md` |
| 4 | Snapshot hardware spike, Samsung, go / no-go | Fable 5.2 / high | Fixes the permission list for the Play declaration; the capture build follows release |
| 5 | Core journey in the app: push registration, stolen state, trail, pack viewer | Sonnet 5.5 / high | Done when a theft drill on a real phone against production ends in the signed PDF. Push waits on Firebase |
| 6 | Account deletion and data export, backend and app | Opus 5.5 / high | Play requires a deletion path in-app and on the web |
| 7 | Android release pipeline, signing out of the repo, Data Safety and background-location declarations | Opus 5.5 / medium | An update to a live listing |
| 8 | UI pass on the release screens (M5a, then M5b) | Opus 5.5 / high, then Sonnet 5.5 / high | The rest of the screens continue after release |
| 9 | Pre-launch audit, then a staged rollout | Fable 5.2 / high | |
| 10 | Snapshot capture (M3b), remote commands, Play Billing 3b | as the tables below | |
| 11 | iOS (M3d, M4) | as the tables below | Apple account and Codemagic setup can start earlier; they have lead time |
| 12 | Partner track: App Widget, runtime theming, claim flow, Play Integrity, integration guide | as the tables below | Starts when W6 names a first partner |

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
