# App screens ↔ backend gap analysis (2026-09-09)

Walkthrough of the built Android screens (Home, Unlock log, Plans, Settings,
Account) against what the backend actually serves — what's ready, what's
client-local, what has no backend yet. For the Android engineer and for sprint
planning.

## Ready on the backend today

| Screen element | Backend |
|---|---|
| Home: failed-unlock counters, "attempt N in that run", last attempt time | `GET /api/v1/devices/:id/activity` — `inWindow`, `toThreshold`, `threshold`, `lastAttemptAt`, `recent[]` ([contract §5](./f1-client-contract.md)) |
| Unlock log: coordinates per failed attempt | `activity.recent[].location` (new — parsed from the `UNLOCK_FAILED` payload's `location`; see contract §2). **The phone must include the fix in the payload** for these to be server-backed. |
| Account: auth details (email verified, member since) | `GET /api/auth/me` |
| Account: active sessions + revoke | `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`; `okhttp/4.9.2` is the stored user agent |
| Settings: sign out / sign out everywhere | `POST /api/auth/logout`, `POST /api/auth/logout-all` (built + tested) |
| T&C / privacy acceptance at login | **New:** `GET /api/v1/legal`, `GET /api/v1/legal/status`, `POST /api/v1/legal/accept` ([legal-api.md](./legal-api.md)) |
| Intruder alert emails to owner + buddies | First alert + evidence pack ([f1-failed-unlock-alert-flow.md](./f1-failed-unlock-alert-flow.md)); alert now carries IMEIs + last known location |

## Client-local by design (no backend, correctly)

- **Unlock log "Clear all"** — clears the phone's local log only. Server-side
  evidence is deliberately not owner-deletable: it is tamper-evident material
  with TTL-based retention (90d routine / 365d episode). Don't add a delete
  API for it.
- **Successful-unlock rows with coordinates** — the server stores no
  "successful unlock" event today (`ENVELOPE_TYPES` has no such type). These
  rows are the phone's local log. If we want them server-side (cross-device
  unlock history), that's a product decision — see recommendations.

## No backend yet (decide/scope)

1. **Plans / subscriptions (Free $0, Pro $4.99, Family $9.99).** Nothing
   server-side; the Settings "Free plan" row is hardcoded client-side. Now
   scoped in [plans-scoping.md](./plans-scoping.md) (decision 2026-09-09:
   scope first). Until built, the app should treat every account as Free.
2. **Push notifications ("Real-time intruder alerts").** Alerts are email-only
   today (the deliberate backbone channel). Real-time push needs FCM device
   registration + a notification dispatch alongside `sendFirstAlert`. Note the
   App-info screenshot shows **notifications Blocked** at the OS level — email
   remains the channel that cannot be silenced by one toggle.
3. **Familiar locations + location trail views** — scoped in
   [f3-location-trail-scoping.md](./f3-location-trail-scoping.md).
4. **SMS OTP / verified phone number** — scoped in
   [sms-otp-scoping.md](./sms-otp-scoping.md) (decision 2026-09-09).

## Decisions recorded 2026-09-09

- **Legal gate:** device enrolment requires current T&C + privacy acceptance
  (`403 legal_acceptance_required`); existing-device management is never
  gated. See [legal-api.md](./legal-api.md).
- **Buddy alert detail:** buddies receive the SAME first-alert detail as the
  owner (IMEIs + last known location) — deliberate: buddies exist to block the
  SIM and file the police report fast, and their in-app acceptance is the
  consent for it.

## Paper cuts spotted in the screens

- The location-permission modal says "**Tabo** records your device location…"
  — typo for Tambo.
- That modal's claim ("records your device location at unlock so you know
  where it was accessed") must be reflected in the privacy policy the legal
  API now serves — location-at-unlock is exactly the kind of processing that
  needs explicit disclosure.
- The Account screen's user agent row shows `okhttp/4.9.2`; sending a
  meaningful `User-Agent` (app name + version) would make the sessions list
  legible to users ("Tambo Android 1.4 on Tecno Spark 20").
