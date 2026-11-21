# Deploy runbook

How `main` reaches `api.tambo-app.com`. The image is the [Dockerfile](../Dockerfile)
and nothing else is host-specific: any platform that runs a container, injects
environment variables and routes HTTPS to port 3000 will do. Edge and DNS are in
[cloudflare.md](cloudflare.md).

**Production is behind `main`** (found 2026-11-21: `/api/v1/plan`,
`/api/v1/client/config`, `/api/openapi.json` and `/api/v1/legal` all answer 404).
**The app on Google Play is live**, so a deploy must not break installed builds.
That check is done and its result is below; read it before the first deploy.

## 1. What an installed build needs from `main`

The published app (versionCode up to 7, Kevin's commit `2d8b7d0`, no
`X-Client-*` headers) was replayed against `main` in
[tests/legacyClient.test.ts](../tests/legacyClient.test.ts). Every call it makes
still works except two behaviours, both now handled for header-less builds:

| Break | What the build does | What `main` now does |
|---|---|---|
| Login of an account whose mailbox was never proven | Expects `403 email_unverified` with a `challenge`; on `200 { challenge }` it throws on `response.user.name` and shows "Could not sign you in" | Header-less callers get the 403 shape; callers sending `X-Client-Platform` get the documented `200 { challenge }` |
| Device enrolment (`POST /devices`) | Never calls `POST /legal/accept` (its terms sheet is stored on the phone only), so `main`'s gate answers `403 legal_acceptance_required` and the phone silently never enrols | Header-less callers are exempt while `LEGACY_CLIENT_LEGAL_EXEMPT=true` (default). Owner decision 2026-11-21. Each exempt enrolment logs `legacy client enrolling without a recorded legal acceptance` |

Everything else the build calls (register, OTP verify and resend, refresh, me,
sessions, logout, forgot and change password, buddies, buddy invites, protecting,
report-stolen, device token revoke, evidence ingest and heartbeat) matches.

**Not verified:** which build is live on Play. The repo has versionCode 7 at its
latest; the Play Console value was not available. If a build older than 5 is
live, replay its calls too. The replay runs against an in-memory database, not
production data, so step 6 repeats the unverified-login case against the real
deployment.

### Retiring the exemptions

Both exist for the old build only. Once the app update that records legal
acceptance and handles the `200 { challenge }` login is the minimum version
(`CLIENT_MIN_VERSION_ANDROID`):

1. Count `legacy client enrolling...` log lines over a week; expect them to stop.
2. Set `LEGACY_CLIENT_LEGAL_EXEMPT=false`.
3. The 403 login shape then only affects clients that send no headers at all.
   Remove it from `auth.controller.ts` and the registry when no live build needs it.

**App-side note:** the app repo at `HEAD` (M2 onward) sends `X-Client-Platform`
but its `LoginScreen` still only handles `403 email_unverified`. A build from it
would show "Could not sign you in" for an unverified account, so the login
screen must branch on a `challenge` in the 200 body before the next release.

## 2. Before the first deploy

- **Snapshot the database.** `MONGODB_URI` points at the shared Atlas cluster.
  Take an Atlas snapshot (or `mongodump`) first; the new build adds collections
  and indexes, never rewrites existing documents, but a snapshot is the only
  rollback for data.
- **Indexes build at boot and block startup** (`config/database.ts`). A unique
  index that cannot build over existing rows makes the process exit; the log
  line is `MongoDB connection error`. Expect first boot to take longer than later ones.
- **Reuse the current host's environment, do not regenerate it.** In particular
  `JWT_ACCESS_SECRET` (changing it signs every user out when access tokens
  expire) and `PACK_SIGNING_SEED` (changing it breaks verification of every
  evidence pack already issued).
- **Run one instance.** The retention sweep, the quiet-device watchdog and the
  webhook retry loop are in-process timers; two instances double-send the
  watchdog's emails. Scale up only after these move to a single-runner job
  (see the roadmap).

## 3. Configuration

Everything is environment. [.env.example](../.env.example) is the full list;
the ones a production boot refuses to start without or that matter on day one:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (anything else is treated as non-local and demands the secrets below) |
| `MONGODB_URI` | the Atlas connection string |
| `JWT_ACCESS_SECRET`, `PACK_SIGNING_SEED` | existing values, see above |
| `MAIL_DRIVER` | `resend`, with `RESEND_API_KEY` and `MAIL_FROM` on the verified domain ([cloudflare.md](cloudflare.md) section 1). `console` means no real user gets an OTP |
| `API_PUBLIC_URL` | `https://api.tambo-app.com` (used in emailed links) |
| `TRUST_PROXY` | hop count from [cloudflare.md](cloudflare.md) section 3; wrong silently breaks per-IP rate limits |
| `PUSH_DRIVER` | `console` until the Firebase service account arrives, then `fcm` with `FCM_SERVICE_ACCOUNT_JSON` |
| `CLAIM_INTEGRITY` | `off` (`required` refuses to boot: no verifier exists) |
| `WEBHOOK_ALLOW_LOCAL_TARGETS` | `false` (`true` refuses to boot outside development and test) |
| `LEGACY_CLIENT_LEGAL_EXEMPT` | `true` until section 1's retirement steps |
| `CLIENT_MIN_VERSION_ANDROID` | leave unset: forcing an update before one exists locks users out |

Secrets live in the platform's secret store, never in the image (`.env` is in
`.dockerignore`) and never in a log line.

## 4. Build and run

```bash
docker build -t tambo-api .
docker run --rm -p 3000:3000 --env-file prod.env tambo-api   # prod.env stays out of git
```

The image is two-stage (`npm ci` and `tsc` in the first, production
dependencies and `dist/` in the second), runs as the unprivileged `node` user,
and has a `HEALTHCHECK` on `/api/health`, which is `503` while the database is
down. Node handles `SIGTERM` (every deploy sends one): it stops accepting
connections, lets in-flight requests finish (evidence uploads included), closes
the database and exits 0, or exits 1 after 10 seconds. Give the platform a
termination grace period of at least 15 seconds.

The Dockerfile was **not built on the machine that wrote it** (no Docker
there). What was verified instead: `npm run build` and `node dist/server.js`
with `NODE_ENV=production`, environment-only configuration and a throwaway
MongoDB, including a clean `SIGTERM` exit. The first real `docker build` is part
of the first deploy.

Media (evidence photos) is stored in MongoDB GridFS, so the container keeps no
state and needs no volume.

## 5. Deploy

1. CI is green on the commit (`typecheck`, `lint`, `format:check`, tests with the
   coverage ratchet, spec and client in sync).
2. Snapshot the database (section 2).
3. Build the image, tag it with the commit SHA, push it to the registry.
4. Start it with the production environment. Wait for `/api/health` to answer
   `200` and for the log line `MongoDB connected`.
5. Route traffic to it. Keep the previous image tagged: rollback is
   redeploying it. New indexes and collections are additive and harmless to the
   old build.

## 6. Smoke test (read-only except the throwaway sign-up)

```bash
H=https://api.tambo-app.com
curl -s $H/api/health                                   # status ok, database connected
curl -s -o /dev/null -w '%{http_code}\n' $H/api/openapi.json          # 200
curl -s -o /dev/null -w '%{http_code}\n' $H/api/v1/plan               # 401 (was 404)
curl -s "$H/api/v1/client/config?platform=android"                    # 200, no secrets
curl -s $H/api/v1/legal                                               # two documents
```

Then, with a throwaway address you control, prove the legacy path end to end
(this is the check the unit exists for):

1. `POST /api/auth/register` with that address, and do **not** enter the code.
2. `POST /api/auth/login` with no client headers: expect `403` with
   `code: "email_unverified"` and a `challenge`.
3. `POST /api/auth/otp/verify` with the emailed code: expect `200` and tokens.
4. Install the Play build on the Samsung and sign in with that account: it should
   reach Home and enrol (the server log shows the legacy-enrolment line).

Last, check the rate limiter sees real client IPs: bad-login warn lines from two
networks must show different `ip` values.

## What this runbook does not decide

- **The hosting platform.** The image runs anywhere; the owner's choice (the
  region and DPIA are in place) is recorded here when made.
- **Single-instance timers**, **S3 media** and **webhook secrets at rest** are
  roadmap items; none blocks a first deploy at launch volume.
