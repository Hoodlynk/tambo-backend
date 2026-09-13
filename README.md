# Tambo Backend

The backend of the Tambo anti-theft product: **Express + TypeScript +
Mongoose**. A phone theft becomes a filed, evidenced, insurer-ready pack:
enrol device → evidence uploads → episode opens (threshold or owner) → first
alert (email + push) in seconds → Ed25519-signed evidence pack by email.

**One API, three clients.** The contract is an OpenAPI spec generated from
the same zod schemas the server validates with (`GET /api/openapi.json`,
committed at `openapi/openapi.json`); clients consume generated types, never
hand-written ones ([docs/client-generation.md](docs/client-generation.md)).

| | Android (RN) | iOS | PWA |
|---|---|---|---|
| Failed-unlock capture + evidence upload | ✓ | — (platform ceiling) | — |
| Owner console: devices, episodes, trail, pack, buddies, plan | ✓ | ✓ | ✓ |
| Push alerts (FCM) | native | APNs relay | web push |
| Sessions | refresh token in body | refresh token in body | httpOnly cookie (`/api/auth/web`) |

## Quick start

New here? **[ONBOARDING.md](ONBOARDING.md)** gets you to a running, seeded
backend + a typed client in <10 minutes. The short version:

```bash
npm install
cp .env.example .env          # fill in MONGODB_URI and JWT_ACCESS_SECRET
npm run dev                   # http://localhost:3000
npm run seed:dev              # user + device + open episode + evidence
curl localhost:3000/api/health
```

Contributing to the backend itself: read [CLAUDE.md](CLAUDE.md).

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Watch mode via nodemon + ts-node |
| `npm run build` | Compile `src/` to `dist/` |
| `npm start` | Run the compiled server |
| `npm test` / `test:coverage` | Jest against a real in-memory MongoDB (coverage has a ratchet) |
| `npm run typecheck` | Type-check `src/` **and** `tests/`, no emit |
| `npm run lint` / `lint:fix` | ESLint |
| `npm run format` / `format:check` | Prettier |
| `npm run openapi` / `client:ts` | Regenerate the OpenAPI spec / typed TS client |
| `npm run seed:dev` | Seed a dev database (user, device, episode, evidence) |

## Documentation

Indexed in **[docs/README.md](docs/README.md)**. Highlights:

- [docs/architecture.md](docs/architecture.md) — layering, conventions, how a request flows
- [docs/auth-api.md](docs/auth-api.md)
- [docs/devices-api.md](docs/devices-api.md) — devices, theft episodes, buddies (F-A)
- [docs/evidence-api.md](docs/evidence-api.md) — evidence ingest: envelopes, media, retention (F-B)
- [docs/trail-api.md](docs/trail-api.md) — location trail, static vs moving, familiar locations (F3)
- [docs/f1-how-it-is-built.md](docs/f1-how-it-is-built.md) — failed-unlock reporting: how the backend half is built
- [docs/f1-client-contract.md](docs/f1-client-contract.md) — the Android ↔ backend wire contract for F1 — endpoint reference and error codes
- [docs/evidence-features-plan.md](docs/evidence-features-plan.md) — the next three features: devices/episodes, evidence ingest, pack & delivery
- [docs/cloudflare.md](docs/cloudflare.md) — operator runbook: Resend DNS, proxying, TRUST_PROXY
- [docs/security.md](docs/security.md) — the threat model and what defends against what
- [docs/access-tiers-decision.md](docs/access-tiers-decision.md) — how deep Tambo can go, and the consumer-vs-device-owner decision
- [docs/roadmap.md](docs/roadmap.md) — build plan & status: what is done, what is next, open decisions

## Testing

Tests run against a real MongoDB (`mongodb-memory-server`), not mocks — index
constraints, TTL behaviour and query semantics are therefore actually exercised.
One server is started per run and each jest worker uses its own database.

On macOS 12 and older the default MongoDB 8.x binary will not run; the suite
pins 6.0.14. Override with `MONGOMS_VERSION` where a newer build is fine (a
Linux CI runner, for example).

**Transport note**: suites share ONE listening server each
(`tests/setup/testServer.ts`) instead of supertest's default
server-per-request. The default's thousands of ephemeral bind/close cycles per
run caused kernel port-recycling collisions on older macOS dev machines -
requests occasionally landed on the wrong server and returned "phantom"
responses this app cannot produce. The shared server eliminated it (verified
over repeated full-suite stress runs); `tests/helpers/http.ts` keeps a
phantom-detecting retry in scaffold steps as a safety net (assertions never
retry).

## Requirements

Node 20+, and a MongoDB instance for anything other than running the tests.
