# Backend project skeleton — the reusable blueprint

A distilled, project-agnostic template of how this codebase is structured and
why it stays healthy. Copy this file into a new repo (or hand it to whoever is
bootstrapping one) and build to it. Nothing here is Tambo-specific — Tambo is
just the worked example.

**Stack assumed:** Node + TypeScript + Express + Mongoose + Zod + Jest.
The *patterns* transfer to any stack; the snippets assume this one.

---

## 1. Directory layout

```
src/
  server.ts               # boot only: connect DB, listen, start background jobs, log config facts
  app.ts                  # the Express app: middleware order, route mounting, error tail
  config/
    config.ts             # ALL env access lives here; validated at boot; typed
    database.ts           # connection
    rateLimits.ts         # named limiter rules registry
  routes/                 # HTTP surface: paths + middleware chains, nothing else
    <area>.routes.ts      #   unversioned infra (auth, health)
    v1/<area>.routes.ts   #   versioned product API
  controllers/            # marshal HTTP <-> service calls; zero business logic
  services/               # ALL business logic; controllers and models stay thin
    <provider>/           # third-party seams as driver folders (see §5)
  models/                 # Mongoose schemas + indexes + toJSON scrubbing
  middlewares/            # auth, validate, rateLimit, error handler, feature gates
  validation/             # zod schemas, one file per area
  utils/                  # AppError, asyncHandler, tokens/crypto, tiny helpers
  types/express.d.ts      # request augmentation (req.auth etc.)
tests/                    # integration-first, one file per feature area
  helpers/                # factories (registerUser...), db lifecycle, http retry
  setup/                  # env, in-memory DB global setup/teardown, testServer
scripts/                  # operational tools (mail-test etc.) - INSIDE lint/typecheck globs
docs/                     # one doc per API area + runbooks + scoping docs
.env.example              # every env var, documented, safe defaults
```

**The dependency rule:** `routes → controllers → services → models`. Never
skip layers downward-only is fine (services use models), never sideways-up
(a model never imports a service; a controller never touches a model
directly). Cross-service imports are fine; if two services need each other
(a cycle), extract the shared piece into its own module — that is why
`evidenceLocation.ts` exists rather than delivery↔evidence importing each other.

## 2. Config: the app refuses to run misconfigured

One `config.ts` exporting a single typed object. Rules:

- **No `process.env` anywhere else.** Ever. Grep-enforceable.
- Every secret uses a `required()` helper: a built-in fallback is allowed ONLY
  when `NODE_ENV` is explicitly `development`/`test`, announces itself with a
  warning, and everything else (production, staging, typos, unset) **refuses
  to boot**.
- Enum-shaped vars (mail driver, trust-proxy) are parsed by small validators
  that throw on unknown values — no silent fallback that could route OTP codes
  to stdout in production.
- Cross-field requirements validated at boot too (`driver=resend` without an
  API key ⇒ refuse to start).
- Every var appears in `.env.example` with a comment saying what it does and
  what happens when you change it. The example file is the ops contract.
- `server.ts` logs load-bearing config facts at boot (e.g.
  `Mail: driver=console (NOT a real provider...)`) so a misconfigured deploy
  is visible in the first ten log lines.

## 3. The request pipeline (same order, every route)

```ts
router.post('/thing',
  requireAuth,                 // 1. who are you (sets req.auth)
  requireFeatureGate,          // 2. optional policy gates (e.g. legal acceptance)
  validate({ body: schema }),  // 3. shape/normalize BEFORE rate limiting
  rateLimit({ name: 'thing', subject: bodyField('email') }),  // 4. budget
  asyncHandler(controller.fn), // 5. the handler
);
```

Why this order: `validate` runs before `rateLimit` so the limiter keys on
*normalized* values (`A@x.com` and `a@x.com` share one budget) and malformed
requests never consume budget.

The five pieces, all reusable verbatim:

- **`asyncHandler`** — wraps every async handler so rejections reach the error
  handler (Express 4 doesn't do this for you).
- **`validate`** — zod-parses body/params/query and **replaces** them with the
  parsed result: unknown keys are stripped (nobody smuggles `role: "admin"` or
  `emailVerifiedAt` into a create), trims/lowercases already applied. Handlers
  may trust the shape.
- **`requireAuth`** — Bearer JWT → `req.auth = { userId, role }` (typed via
  `types/express.d.ts`). Machine credentials (device tokens, webhooks) get
  their own middleware and their own token namespace — never user sessions.
- **`rateLimit`** — named rules in one registry (`config/rateLimits.ts`),
  typed keys so a missing rule is a compile error; counter keyed on
  `ip|subject` hashed (never store raw emails in the counter collection);
  window anchored to the first hit; 429s carry `Retry-After`.
- **`errorHandler` tail** — `notFoundHandler` then the global error handler,
  always last in `app.ts`.

## 4. Errors: a stable machine contract

One `AppError` class: `statusCode`, stable `code` string, optional per-field
`details`, optional `retryAfterSeconds`. Constructors for the common statuses
(`badRequest/unauthorized/forbidden/notFound/conflict/tooManyRequests/validation`).

- Anything thrown that is NOT an AppError is a bug and surfaces as a generic
  500 — internal detail never leaks.
- **Clients branch on `code`, never on `message`.** Messages are free to
  change wording; codes are forever. Document every code in the area's doc.
- Deliberate ambiguity is a feature where enumeration is a risk: one
  `invalid_credentials` for wrong-password AND unknown-email; password reset
  returns 204 unconditionally; compare against a dummy bcrypt hash so timing
  doesn't leak account existence.

## 5. Third-party seams: interface + drivers, selected by config

Every external provider is a folder:

```
services/mailer/
  mailer.interface.ts   # the seam: send(message): Promise<void>
  console.mailer.ts     # dev: print to stdout
  noop.mailer.ts        # tests: record into .sent[], deliver nothing
  <vendor>.mailer.ts    # production: thin fetch wrapper, throws with status+detail
  index.ts              # exhaustive driver map keyed by validated config enum
```

This buys you: swap vendors in one file; tests assert on captured messages
with zero mocking framework; boot-time validation makes "prod accidentally on
the console driver" impossible to miss. Apply the same shape to SMS, push,
payments, object storage.

**The fire-and-forget rule + its tax.** Side-channel sends (email, push,
webhooks) are dispatched `void provider.send(...).catch(log)` so a vendor
outage never blocks or time-fingerprints the request that triggered them. The
tax you MUST pay for that invisibility:
- every failure logs with purpose + recipient,
- a `scripts/<provider>-test.ts` tool that AWAITS the provider and prints the
  real rejection (`npm run mail:test -- you@example.com`),
- a runbook (`docs/<provider>-runbook.md`) for the "API is up but nothing
  arrives" incident class.

## 6. Models: schemas are also the security boundary

- **`toJSON` transforms strip secrets at the source** — password hashes, token
  hashes, audit PII (IP, user agent) — so no controller can leak what the
  serializer already removed. `select: false` on secret fields; services that
  need them opt in with `.select('+field')`.
- **Uniqueness lives in unique indexes, not pre-checks.** Create and translate
  the duplicate-key error (`isDuplicateKeyError`) — pre-check + insert is a
  race. Partial/sparse unique indexes are the referee for "at most one open X
  per Y" invariants (one open episode per device, one first-alert per
  recipient per episode).
- **Atomic claims for single-use things.** OTP codes, reset tokens, refresh
  rotations: `findOneAndUpdate({ _id, consumedAt: { $exists: false } }, { $set:
  { consumedAt: now } })` — the winner of a concurrent double-submit is decided
  by the database, not by application luck.
- Tokens are stored **hashed** (sha256 for opaque tokens, bcrypt for
  low-entropy codes); the plaintext appears in exactly one response, once.
- TTL indexes for anything self-expiring (rate-limit counters, retention), and
  remember TTL sweeps are lazy (~60 s) — code must tolerate an expired-but-
  present row.
- Two clocks where clients can lie: record BOTH `capturedAt` (client claim)
  and `receivedAt` (server truth); server logic (thresholds, ordering) uses
  server time only.

## 7. Auth blueprint (lift wholesale)

- Short-lived JWT access token (~15 min) + rotating opaque refresh token
  (stored hashed, per-session row with user agent, `current` detection via an
  `X-Refresh-Token` header on list).
- `sessionsInvalidatedAt` watermark on the user for "sign out everywhere" that
  even beats concurrently-rotating tokens.
- Sensitive changes (password/email) are **two-step**: prove the current
  credential, park the pending change on an emailed OTP challenge, apply it
  only on verify — then revoke every other session and outstanding reset link.
- Registration is OTP-gated: account created unverified, challenge returned
  (no session), verify sets `emailVerifiedAt` + issues the first session.
  Unverified addresses are superseded by re-registration (no squatting);
  verified addresses 409. Login returns a challenge instead of a session for
  never-verified accounts.
- OTP mechanics: 6-digit crypto-random, hashed at rest, TTL ~10 min, ~5
  attempt budget, resend rotates the code under a cooldown WITHOUT extending
  expiry or resetting the budget.

## 8. Tests: integration-first, HTTP-level, factory-driven

- **Test through the HTTP surface** with supertest against the real `app` —
  routes, middleware order, validation, and serialization are all under test
  for free. Unit-test only pure seams (drivers with a mocked `fetch`, parsers).
- In-memory MongoDB per run (`mongodb-memory-server`); `clearTestDb` between
  tests; capped `maxWorkers` (oversubscription causes transport flakes).
- **`tests/helpers/factories.ts` is the contract mirror**: `registerUser()`
  performs the FULL real flow (register → read OTP from the noop mailer →
  verify → accept legal docs) and returns a session. When a flow gains a step,
  the factory gains it too and the whole suite keeps passing — with opt-outs
  (`{ acceptLegal: false }`) for testing the gate itself.
- The noop driver's `.sent[]` is how you assert on outbound messages —
  including pulling real OTP codes out of captured mail.
- Test the *invariants*, not just happy paths: concurrent double-submits
  converge, budgets burn, secrets never serialize (`JSON.stringify(body)`
  must not contain `$2b$`), unknown keys are stripped, and the same error body
  comes back for wrong-password vs unknown-email.
- Config lives in `tests/setup/env.ts` (noop drivers, rate limits off except
  in the rate-limit suite, bcrypt rounds lowered).

## 9. Tooling: green means green

```jsonc
// package.json scripts
"build":  "tsc",
"dev":    "nodemon --watch src -e ts --exec ts-node --files src/server.ts",
"lint":   "eslint \"{src,tests,scripts}/**/*.ts\"",   // scripts/ INCLUDED
"test":   "jest",
"format": "prettier --write \"{src,tests,scripts}/**/*.{ts,js,json}\"",
"typecheck": "tsc --noEmit -p tsconfig.test.json"      // includes src+tests+scripts
```

- `tsconfig`: `strict`, plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` — the two flags that actually catch bugs in
  this style of code. `skipLibCheck` on.
- Everything the repo executes is inside the typecheck/lint/format globs —
  an operational script that can rot silently is worse than none.
- Definition of done for any change: full test suite + typecheck + lint +
  format:check all green, and the area doc updated.

## 10. Docs culture (what made this repo navigable)

- `docs/<area>-api.md` per API area: endpoints, request/response shapes,
  **every error code**, and the flow diagram in ASCII. Written for the client
  developer, not for the backend author.
- `docs/<incident>-runbook.md` for each invisible failure class.
- `docs/<feature>-scoping.md` for decided-but-not-built work: requirements,
  proposed design, explicit non-goals ("familiar locations never relax
  rules"), open product questions. Scoping docs stop re-derivation.
- Decisions get a dated line in a gap-analysis/decisions doc — "deliberate,
  not forgotten" is a sentence someone will need in six months.
- Comments in code state constraints the code can't show (why validate before
  rateLimit; why the dummy hash exists) — never what the next line does.

## 11. Security defaults checklist (day one, every project)

- [ ] `helmet()`, `x-powered-by` disabled
- [ ] CORS: explicit origin allowlist, empty = deny (mobile-only APIs need none)
- [ ] `trust proxy` set to the REAL proxy count, validated as an integer at boot
- [ ] JSON body cap (~100kb) with per-route opt-outs that set their own caps
- [ ] Rate limits on every unauthenticated endpoint, keyed on ip+subject
- [ ] All tokens hashed at rest; plaintext shown exactly once
- [ ] `toJSON` scrubbing on every model with a secret or PII
- [ ] Enumeration-safe auth errors and unconditional 204s where relevant
- [ ] Machine credentials (devices, webhooks) separate from user sessions
- [ ] Consent/legal gates on the action that STARTS data processing, never on
      actions a locked-out user needs mid-incident
- [ ] `.env` gitignored; `.env.example` complete and commented

## 12. Bootstrapping a new repo from this skeleton

1. Copy the layout (§1), tooling (§9), and these files nearly verbatim:
   `appError.ts`, `asyncHandler.ts`, `validate.ts`, `rateLimit.ts` +
   `rateLimits.ts`, `errorHandler.ts`, `mongoErrors.ts`, `tokens.ts`,
   the mailer driver folder, `tests/setup/*`, `tests/helpers/db.ts` + `http.ts`.
2. Write `config.ts` first — decide every env var and its boot-time rule
   before any feature code.
3. Stand up the auth blueprint (§7) or your project's equivalent identity
   seam, WITH its factories and test suite, before the first product feature.
4. First product feature = model + validation + service + controller + route +
   test file + `docs/<area>-api.md`, in that order.
5. From then on, the loop is: schema → service → route → tests → docs, and
   the §9 gate before every commit.
