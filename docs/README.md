# Tambo backend documentation

Start here. **Building a client (Android / iOS / PWA)?** Read the error-code
rule in [architecture.md](architecture.md#error-model), generate a typed
client ([client-generation.md](client-generation.md)), then open the API
reference for your feature.

## API references (per feature)

| Doc | Covers |
|---|---|
| [auth-api.md](auth-api.md) | Register, login, OTP challenges, sessions, password lifecycle |
| [android-otp-email-guide.md](android-otp-email-guide.md) | The OTP flows from the client's point of view — screens, branches, error codes |
| [devices-api.md](devices-api.md) | Device enrolment, ingest tokens, theft episodes, buddies |
| [evidence-api.md](evidence-api.md) | Evidence envelope ingest, media upload, retention |
| [trail-api.md](trail-api.md) | Location trail, static vs moving, familiar locations (F3) |
| [legal-api.md](legal-api.md) | T&C / privacy versions, scroll-gated acceptance, the enrolment gate |
| [f1-client-contract.md](f1-client-contract.md) | The Android ↔ backend wire contract for failed-unlock reporting |
| [client-generation.md](client-generation.md) | Generating typed API clients from the OpenAPI spec |
| [android-feedback-2026-09-12.md](android-feedback-2026-09-12.md) | Review of the app's auth/terms work — the 3 contract fixes needed |

## Architecture & decisions

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | Layering, request lifecycle, the error model, session design — **read first** |
| [security.md](security.md) | Threat model: what defends against what |
| [access-tiers-decision.md](access-tiers-decision.md) | How deep Tambo can go on a phone, and via which distribution tier |
| [roadmap.md](roadmap.md) | Build plan & status — what is done, what is next |
| [evidence-features-plan.md](evidence-features-plan.md) | The F-A/F-B/F-C feature designs (devices, ingest, pack) |
| [plans-scoping.md](plans-scoping.md) | Free/Pro/Family entitlements & billing scoping |
| [f3-location-trail-scoping.md](f3-location-trail-scoping.md) | F3 product intent and design (built) |
| [sms-otp-scoping.md](sms-otp-scoping.md) | Phone OTP design (on hold: SMS provider) |
| [project-skeleton.md](project-skeleton.md) | The reusable backend skeleton blueprint |

## F1 (failed-unlock) deep-dives

| Doc | Covers |
|---|---|
| [f1-how-it-is-built.md](f1-how-it-is-built.md) | How the backend half works |
| [f1-android-audit.md](f1-android-audit.md) | Audit of the Android app + the exact client-side fix |
| [f1-failed-unlock-alert-flow.md](f1-failed-unlock-alert-flow.md) | End-to-end alert flow |
| [f1-screens-gap-analysis.md](f1-screens-gap-analysis.md) | App screens vs backend reality |

## Operator runbooks

| Doc | Covers |
|---|---|
| [cloudflare.md](cloudflare.md) | DNS, Resend records, proxying, TRUST_PROXY |
| [otp-mail-runbook.md](otp-mail-runbook.md) | Diagnosing OTP/email delivery |
