# OTP / email delivery runbook — "OTP is down" diagnosis

**The September 2026 incident:** users reported OTP codes never arriving; the
API returned success everywhere. Root cause class: **email sends are
fire-and-forget by design**, so a failing mail provider is invisible at the API
surface. This runbook is how to see it.

## Why the API can be "up" while OTP is "down"

Every send (OTP codes, first alerts, evidence packs, buddy invites, password
resets) is dispatched with `void mailer.send(...).catch(console.error)` — a
provider outage or rejection must never block or time-fingerprint an auth
endpoint (see [`src/services/otp.service.ts`](../src/services/otp.service.ts)).
The consequence: **the only place a failed send shows up is the server log.**
The full test suite passing proves the logic, not the delivery.

## Diagnosis checklist, in order

1. **Which driver is live?** The server now logs it at boot:

   ```
   Mail: driver=console from="Tambo <no-reply@tambo.local>" (NOT a real provider - no email leaves this process)
   ```

   `MAIL_DRIVER` must be `resend` in any environment where a human expects an
   email. `console` prints mail to stdout; `noop` discards it. (An unknown
   value, or `resend` without `RESEND_API_KEY`, refuses to boot — that guard is
   in [`src/config/config.ts`](../src/config/config.ts).)

2. **Prove the mail leg end-to-end** with the same env as the deployed process:

   ```
   npm run mail:test -- your@address.com
   ```

   Unlike the app's sends, this one **awaits** the provider and prints the
   actual rejection ([`scripts/mail-test.ts`](../scripts/mail-test.ts)).

3. **Check the logs for the swallowed errors.** Grep for
   `Failed to send` — every fire-and-forget failure logs with purpose and
   recipient, and the Resend driver includes the provider's status + body.

## The known traps

- **Resend onboarding mode.** Until a sending domain is verified in the Resend
  dashboard, the account can only send *from* `onboarding@resend.dev` and only
  *to the Resend account owner's own address*. Every other recipient is
  rejected with a 403 — which the app swallows. This looks exactly like "OTP
  works for the developer, down for everyone else." Fix: verify the domain
  (see [cloudflare.md](./cloudflare.md)), then set `MAIL_FROM` to an address
  on it.
- **`MAIL_FROM` not on the verified domain** — same class of rejection.
- **Wrong/rotated `RESEND_API_KEY`** — 401 on every send.

## Env checklist for a mail-working deployment

```
MAIL_DRIVER=resend
RESEND_API_KEY=re_...
MAIL_FROM=Tambo <no-reply@<your verified domain>>
```

## What is covered by tests

- OTP challenge lifecycle end-to-end: [`tests/otp.test.ts`](../tests/otp.test.ts)
  and the auth suites (create, resend + cooldown, verify, attempt budget,
  expiry, single-use, per-purpose side effects).
- The Resend driver's request shape and its throw-on-rejection behaviour:
  [`tests/mailer.test.ts`](../tests/mailer.test.ts).
- Alert/pack mail content and recipients: [`tests/pack.test.ts`](../tests/pack.test.ts),
  [`tests/location.test.ts`](../tests/location.test.ts).

What tests **cannot** cover is the provider account state (domain verification,
key validity) — that's what `npm run mail:test` is for.
