# SMS OTP scoping — phone-number verification

**Status: scoping only — not built.** Decision from the 2026-09-09 sprint:
SMS OTP is a real upcoming feature. This is the design so build can start
without re-deriving it.

## What already anticipates it

- `User.phone` exists, reserved, normalized-to-E.164 by convention, with a
  sparse unique index; `User.phoneVerifiedAt` exists
  ([user.model.ts](../src/models/user.model.ts)).
- The OTP challenge machine ([otp.service.ts](../src/services/otp.service.ts))
  is channel-agnostic in shape: hashed single-use codes, per-purpose burn,
  attempt budget, resend cooldown, atomic claim. Only the *dispatch* is
  email-specific.

## Proposed design

### 1. Model changes

- `OtpChallenge` gains `channel: 'email' | 'sms'` (default `'email'` so
  existing rows/flows are untouched) and optional `pendingPhone` (E.164),
  mirroring `pendingEmail`.
- New purpose: `phone_change` (covers first-time add AND change; verifying the
  code sets `phoneVerifiedAt`, mirroring how `email_change` proves the new
  mailbox).

### 2. Dispatch seam

Add an `SmsSender` interface mirroring `Mailer` (`send({to, text})`), drivers
`console | noop | <provider>`, selected by `SMS_DRIVER` with the same
boot-time validation `MAIL_DRIVER` has. `dispatchCode` in otp.service routes on
`challenge.channel`.

### 3. Provider (KE/UG/ZM focus)

| | Africa's Talking | Twilio Verify |
|---|---|---|
| KE/UG/ZM delivery | Strong local carrier routes, local support | Good but routed internationally |
| Price/SMS (KE, approx) | ~KES 0.8/SMS | ~$0.05+/verification |
| Sender ID | Local alphanumeric sender IDs (registration per country) | Needs per-country sender registration too |
| Fraud tooling | Basic | Built-in SMS-pumping protection in Verify |
| Integration | Plain REST, like our Resend driver | SDK or REST |

**Recommendation:** Africa's Talking for cost + local delivery, implemented as
a thin REST driver like [resend.mailer.ts](../src/services/mailer/resend.mailer.ts),
BUT with our own pumping defences (below) since we won't get Twilio's.

### 4. Abuse: SMS pumping is the #1 risk

SMS costs money per send (email doesn't), and "artificially inflated traffic"
attacks request OTPs to premium-rate numbers in bulk. Required before launch:

- Rate limits per phone number AND per IP (the existing `rateLimits` registry
  covers this pattern), tighter than email's.
- Allow-list of destination country codes (launch: `+254`, `+256`, `+260`).
- A daily global SMS budget with an alarm — a runaway bill must page a human.
- Resend cooldown ≥ 60s and no code content in logs (same rules as email).

### 5. What phone verification is FOR (product)

- A second recovery channel when the mailbox is lost.
- SIM-blocking workflows: the police/operator report can cite a verified
  owner number.
- NOT a login identifier in v1 (email remains the account key) — that keeps
  the buddy-invite and password flows untouched.

### Open questions

- Should phone OTP be able to *complete login* (email-less accounts), or only
  verify the number? (Recommend: verify-only v1.)
- Sender ID registration lead time per country — start the paperwork early;
  it is usually the long pole.
