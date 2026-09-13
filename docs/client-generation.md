# Generating typed API clients

**Audience:** the Android, iOS, and PWA engineers.
**The rule:** never hand-write request/response types or invent endpoints —
generate them. This week's lesson: hand-written client types drifted from the
server (a phantom `verify-email` endpoint, a wrong login branch). Generated
types turn that class of bug into a compile error.

## The source of truth

The OpenAPI document is generated **from the same zod schemas the server
validates every request with**, so it cannot drift from actual behaviour:

- Live: `GET https://api.tambo-app.com/api/openapi.json`
- Committed: [`openapi/openapi.json`](../openapi/openapi.json) (regenerate with `npm run openapi`)
- Registry: [`src/openapi/registry.ts`](../src/openapi/registry.ts) — **every new
  endpoint must be added here**; `tests/openapi.test.ts` probes every
  documented path against the live router so a spec/server mismatch fails CI.

Every endpoint documents its **error codes**. Branch on `code`, never on
`message` (architecture.md #error-model).

## TypeScript (React Native app + PWA)

```bash
npm run client:ts        # → clients/typescript/tambo-api.d.ts (committed)
```

Use with plain fetch or `openapi-fetch`:

```ts
import createClient from 'openapi-fetch';
import type { paths } from './tambo-api';

const client = createClient<paths>({ baseUrl: 'https://api.tambo-app.com' });
const { data, error } = await client.POST('/api/v1/auth/login', {
  body: { email, password },
});
if (data && 'challenge' in data) {
  /* OTP screen — this branch is now type-enforced */
}
```

## Swift (iOS)

```bash
brew install openapi-generator
openapi-generator generate -i openapi/openapi.json -g swift5 \
  -o clients/swift --additional-properties=library=urlsession
```

(Or Apple's `swift-openapi-generator` SPM plugin pointed at the same file.)

## Conventions the generator can't express

- **Login branches on body shape**: 200 is either `{ user, tokens }` or
  `{ challenge }` — the union is in the spec; handle both arms.
- **Response objects are open**: the server may ADD fields at any time
  (non-breaking); never fail on unknown keys.
- **`/api/auth/*` is a legacy alias** of `/api/v1/auth/*` — new code uses the
  versioned paths.
- Evidence endpoints authenticate with `X-Device-Token` (the ingest token from
  device enrolment), never with the user's Bearer token.
