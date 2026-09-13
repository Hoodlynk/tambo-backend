# Tambo backend — working rules

Express + TypeScript + Mongoose anti-theft backend. Read
[docs/architecture.md](docs/architecture.md) before changing anything;
[docs/README.md](docs/README.md) indexes every other doc.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Watch mode (nodemon + ts-node) on :3000 |
| `npm test` / `npm run test:coverage` | Jest vs real in-memory MongoDB; coverage has a ratchet |
| `npm run typecheck` | tsc over src **and** tests, no emit |
| `npm run lint` / `format` | ESLint / Prettier (CI gates on both) |
| `npm run openapi` → `npm run client:ts` | Regenerate the spec + typed TS client — **required after any schema/endpoint change**; CI fails on a stale diff |
| `npm run seed:dev` | Verified user + device + open episode + evidence for local client work |

## The rules that keep the codebase honest

1. **Layering**: routes → controllers → services → models. A controller never
   imports a model; a service never touches `req`/`res`; validation happens
   once, at the edge (zod, unknown keys stripped).
2. **Errors are `{ code, message }`**; `code` is contract, `message` is
   wording. New codes must be added to the endpoint's entry in
   `src/openapi/registry.ts`.
3. **Every endpoint lives in `src/openapi/registry.ts`** with its request
   (the SAME zod object the route validates with), response shapes
   (`src/openapi/responses.ts`), and error codes. `tests/openapi.test.ts`
   probes every documented path against the live router.
4. **Plan checks go through `services/entitlements.ts`** — never read
   `user.plan` in a feature service. Evidence upload is never plan-gated.
5. **Familiar locations are interpretation-only** — never imported by
   ingestion or episode opening (they must not affect thresholds/alerts).
6. **Notifications go through `services/notifier.service.ts`**; drivers
   (mail/push) are seams with console/noop/test doubles. Fire-and-forget:
   provider latency never blocks the triggering request.
7. **Secrets never reach a log call.** Config misconfigurations refuse to
   boot rather than degrade (see `config.test.ts` for the pattern).
8. **Tests hit real Mongo** (mongodb-memory-server), one shared listening
   server (`tests/setup/testServer.ts`); factories in `tests/helpers/`.
   Fire-and-forget effects are polled for, never assumed synchronous.
9. Comments explain **why**, never what the next line does. No TODOs — file
   an item in docs/roadmap.md instead.
10. Finish a change with: tests green, lint/typecheck/format clean, spec +
    client regenerated, the relevant `docs/*.md` updated, roadmap entry.
