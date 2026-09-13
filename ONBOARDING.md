# Onboarding — client developers (Android / iOS / PWA) and backend

Goal: a running backend with realistic data, and a typed API client for your
platform, in under 10 minutes.

## 1. Run the backend

```bash
git clone <this repo> && cd tambo-backend
npm install
cp .env.example .env
# fill in exactly two values for local work:
#   MONGODB_URI   - any MongoDB (local `mongod`, Docker, or a dev Atlas db)
#   JWT_ACCESS_SECRET - generate one:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
npm run dev            # http://localhost:3000
curl localhost:3000/api/health
```

Emails (OTP codes, alerts) print to the terminal in development
(`MAIL_DRIVER=console`); push notifications likewise (`PUSH_DRIVER=console`).

## 2. Seed realistic data

```bash
npm run seed:dev
```

Prints credentials, a live access/refresh token pair, an enrolled device with
its **ingest token**, and an open theft episode with located evidence — so
`GET /api/v1/episodes/:id/trail` and `/pack` return something real on your
first call. Re-runnable; refuses to run outside `NODE_ENV=development`.

## 3. Get a typed client

```bash
npm run openapi      # regenerates openapi/openapi.json from the zod schemas
npm run client:ts    # -> clients/typescript/tambo-api.d.ts (RN app + PWA)
```

iOS: see [docs/client-generation.md](docs/client-generation.md) for the Swift
command. **Never hand-write request/response types or invent endpoints** —
the spec is generated from the same schemas the server validates with, and CI
fails if it drifts.

## 4. Read these before writing client code

1. [docs/architecture.md](docs/architecture.md) — especially the **error
   model**: branch on `code`, never on `message`.
2. Your feature's API reference — indexed in [docs/README.md](docs/README.md).
3. [docs/android-otp-email-guide.md](docs/android-otp-email-guide.md) — the
   auth flows from the client's perspective (applies to every platform).
4. PWA only: the web auth surface in [docs/auth-api.md](docs/auth-api.md) —
   httpOnly cookie sessions, the `X-Tambo-Csrf` header,
   `credentials: 'include'`, and your origin in `CORS_ALLOWED_ORIGINS`.

## Platform capability expectations

| | Android | iOS | PWA |
|---|---|---|---|
| Failed-unlock capture + evidence upload | ✓ (device admin) | — (no API) | — |
| Owner console (devices, episodes, trail, pack, buddies) | ✓ | ✓ | ✓ |
| Push alerts | FCM | FCM→APNs | web push |
| Session transport | tokens in body | tokens in body | httpOnly cookie |

The backend serves all three from the same contract; only Android feeds the
evidence pipeline (see [docs/access-tiers-decision.md](docs/access-tiers-decision.md)).

## Backend contributors

Read [CLAUDE.md](CLAUDE.md) (the working rules) and finish every change with:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
npm run openapi && npm run client:ts     # if any endpoint/schema changed
```

CI enforces all of it, including a coverage ratchet and spec-staleness gates.
