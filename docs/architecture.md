# Architecture

## Layering

```
routes/        HTTP surface: path, middleware chain, nothing else
controllers/   marshal req -> service call -> res. No branching, no Mongoose.
services/      business rules. The ONLY layer that touches models.
models/        Mongoose schemas. No business logic.
middlewares/   cross-cutting: auth, validation, rate limiting, errors
validation/    zod schemas; the single source of truth for request shapes
utils/         pure helpers with no framework or database awareness
config/        environment parsing, tunable policy
```

The rules that keep this honest:

1. **A controller never imports a model.** If it needs data, a service provides it.
2. **A service never touches `req` or `res`.** It takes typed objects and throws
   `AppError`. This is what makes services reusable from a job, a CLI, or a
   different transport later.
3. **Validation happens once, at the edge.** Everything downstream may trust the
   shape of its input.
4. **One service file per aggregate**, named exports, no classes.

## Request lifecycle

```
                    ┌─ helmet ─ cors ─ express.json(100kb)
request ────────────┤
                    └─ router
                         │
                         ├─ validate({ body })      parse, normalize, strip unknown keys
                         ├─ rateLimit({ name })     Mongo counter, 429 on overflow
                         ├─ requireAuth             verify Bearer JWT -> req.auth
                         ├─ requireRole('admin')    optional
                         └─ asyncHandler(controller)
                                  │
                                  └─ service ─ model ─ MongoDB
                         │
   notFoundHandler ──────┤ (no route matched)
   errorHandler ─────────┘ AppError -> its status; anything else -> 500
```

### Why `asyncHandler`

Express 4 does not catch a rejected promise from an async handler; the request
would hang until the client times out. Every async route handler is wrapped so
rejections reach `errorHandler` instead.

### Why validation runs before rate limiting

The login limiter keys on the email address, and `validate` is what lowercases
it — so `A@x.com` and `a@x.com` must already be normalized to share one budget.
The trade-off is that malformed requests do not consume budget, which is
acceptable: a malformed request never attempts authentication.

## Error model

Every failure returns the same envelope:

```json
{ "code": "invalid_credentials", "message": "Invalid email or password." }
```

Validation failures add `details`, and 429s add `retryAfter`:

```json
{
  "code": "validation_error",
  "message": "The request body failed validation.",
  "details": [{ "field": "email", "message": "Enter a valid email address." }]
}
```

**Clients must branch on `code`, never on `message`.** Messages are wording and
will change; codes are contract.

`AppError` is the only error type whose message reaches the client. Anything
else is treated as a bug: logged in full server-side, returned as a bare
`internal_error` 500. In development only, the original message is attached as
`detail` for debugging.

## Session design

Access and refresh tokens do different jobs, and conflating them is the usual
source of trouble:

| | Access token | Refresh token |
|---|---|---|
| Format | JWT (HS256) | opaque random 48 bytes |
| Lifetime | 15 minutes | 30 days |
| Stored server-side | no | yes, **SHA-256 hashed** |
| Revocable | no | yes |
| Sent with | every API call | only `/auth/refresh` |

The access token is stateless and therefore fast, and it is short-lived
precisely *because* it cannot be revoked. The refresh token is the opposite:
long-lived, but the database is authoritative, so revocation is immediate.

Only the hash of a refresh token is stored, so a database leak does not hand an
attacker usable sessions.

### Rotation and reuse detection

Each login opens a token **family**. Refreshing revokes the presented token and
issues a successor in the same family. A token presented twice can only mean it
leaked, so the entire family is revoked and that device must sign in again.

This is the mechanism that makes "sign out everywhere", "change password evicts
attackers", and per-device session revocation all work.

### The one trade-off, stated plainly

A stateless access token cannot be revoked mid-life. If a user is demoted from
admin, their existing access token keeps admin rights for up to 15 minutes.
`tests/authorization.test.ts` asserts this behaviour deliberately, so it is a
documented property rather than a surprise. Shorten `JWT_ACCESS_TTL` to narrow
the window; check the database per request if you ever need it to be zero, and
accept the cost.

## Two session surfaces, one session service

Mobile clients exchange the refresh token in the JSON body; the browser (PWA)
surface at `/api/auth/web` keeps it in an httpOnly, path-scoped cookie so page
scripts can never read it, with a CSRF guard (required custom header + Origin
allowlist check) on every cookie-consuming route. Both surfaces call the same
`session.service` - rotation, families, and reuse detection are format-agnostic
- so a session issued on one surface refreshes on the other, and the rate-limit
budgets are shared. See docs/auth-api.md, "The web (PWA) surface".

## Credential-agnostic sessions

`session.service.ts` knows nothing about *how* a user proved their identity —
only that something already did. Credentials live separately:

```
services/
  session.service.ts            issue, refresh, revoke, list      (shared)
  credentials/
    password.credential.ts      email + password
    otp.credential.ts           phone + OTP  (not built - see roadmap)
```

This is what makes phone-OTP login additive rather than a rewrite: it plugs into
the same session machinery, unchanged.

## Configuration

All environment reading happens in `config/config.ts`; nothing else touches
`process.env`. `JWT_ACCESS_SECRET` falls back to a development value outside
production and **throws** in production, so a misconfigured deploy fails at boot
rather than silently signing tokens with a known key.

Abuse budgets live in `config/rateLimits.ts` and are read per request, not
captured at startup, so they can be tuned without restructuring routes.
