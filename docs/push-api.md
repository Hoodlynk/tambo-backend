# Push notifications — token registry and alert fan-out

**Audience:** the Android, iOS, and PWA engineers, plus whoever provisions
Firebase.
**Provider:** Firebase Cloud Messaging only — one credential covers Android
(native FCM), the PWA (web push), and iOS (FCM relays to APNs).

All code: [`src/services/push/`](../src/services/push/) (driver seam),
[`src/services/notifier.service.ts`](../src/services/notifier.service.ts)
(channel fan-out), [`src/services/pushToken.service.ts`](../src/services/pushToken.service.ts)
(registry), [`src/models/pushToken.model.ts`](../src/models/pushToken.model.ts).
Tests: [`tests/push.test.ts`](../tests/push.test.ts).

## Client contract

**Register on every app start** (and after FCM rotates the token):

```
POST /api/v1/push-tokens              (Bearer JWT)
{ "token": "<fcm registration token>", "platform": "android" | "web" | "ios" }
→ 200 { "pushToken": { "platform", "lastSeenAt" } }
```

- Idempotent upsert — re-registering is free.
- A token that belonged to another account is **reassigned**: a phone that
  changes hands stops receiving the previous owner's theft alerts.
- Per-user cap (default 10); least-recently-seen tokens are evicted, which is
  why re-registering on every start matters.

**Unregister on sign-out** (quietly idempotent):

```
DELETE /api/v1/push-tokens            (Bearer JWT)
{ "token": "<fcm registration token>" }
→ 204
```

**The protected phone also registers itself** (B2, remote commands), with
its device token rather than a session:

```
POST /api/v1/evidence/push-token      (X-Device-Token)
{ "token": "<fcm registration token>", "platform": "android" }
```

That binds the install to the enrolled device so remote commands can wake
it with a silent data message (see [commands-api.md](commands-api.md)). A
device register **never turns the account's alerts on** for the install. The
ingest token outlives the owner's sessions, and a phone whose FCM token
rotates in a thief's hands must not start hearing alerts. Only the signed-in
register does that. Send both on app start.

A partner-provisioned phone that nobody has linked yet gets
`409 device_not_linked` here: installs belong to an account, and the phone
has none until it is linked ([provisioning-api.md](provisioning-api.md)).
Register again after linking.

## What gets pushed

| Event | Content | Recipients |
|---|---|---|
| First alert (episode opens) | title "Tambo alert: … may be stolen", `data: { type: "first_alert", episodeId }` | owner + accepted buddies, **once per human per episode** (multicast to all their devices) |
| Remote command issued | **silent data message**, `data: { type: "device_command", commandId, commandType }`, high priority | the device-bound install(s) of that device only |
| Full pack sent | a **nudge** with `data: { type: "full_pack", episodeId }` — never the PDF | owner + accepted buddies with tokens |

Design rules the clients can rely on:

- **Lock-screen safety**: push payloads never carry IMEIs or locations — those
  travel by email and in-app. Route on `data.type` + `data.episodeId`.
- **Channel independence**: email and push claims are separate rows in the
  delivery ledger (`channel` is part of the first-alert uniqueness; push rows
  store the recipient's user id), so one channel failing or being unavailable
  never suppresses the other. A user with no tokens simply gets email only.
- **Delivery is at-most-once per channel**: the claim is recorded before the
  dispatch, so a crash in the millisecond between them cannot double-alert -
  the accepted trade-off is that the push for that episode is then never
  retried. Email is the guaranteed backbone; push is the fast lane.
- **Dead-token hygiene is server-side**: when FCM reports a token dead at send
  time, the row is deleted. Clients never manage registry state.
- **Credential rotation evicts push too**: password change/reset, email
  change, and "sign out everywhere" delete the account's whole push registry
  - a stolen, signed-out device must not keep hearing theft alerts. Your own
  app re-registers on next start (which is why registering on every start is
  the contract). **Exception (B2):** an install bound to an enrolled device
  is kept with alerts switched off, so remote commands can still wake the
  stolen phone. An owner changing their password the minute the phone goes
  missing is the normal case. `DELETE /push-tokens` on a device-bound install
  does the same.
- **The stolen phone never gets the alert about itself**: first alerts and
  pack nudges for an episode skip the install bound to that episode's
  device. A lock-screen "may be stolen" banner tells the thief when to pull
  the SIM.

## Operator setup (human action)

1. Create a Firebase project; enable Cloud Messaging.
2. Generate a service-account key (Project settings → Service accounts).
3. `FCM_SERVICE_ACCOUNT_JSON=$(base64 < service-account.json)` and
   `PUSH_DRIVER=fcm`. A typo'd driver, missing credential, or corrupt base64
   refuses to boot.
4. Deploy note (first deploy with push): the first-alert unique index now
   includes `channel`. Mongoose creates the new index at boot but never drops
   the old `{episode, recipient, kind}` one. Before dropping it manually,
   backfill `channel: 'email'` onto pre-deploy first_alert rows - old rows
   have no stored channel and would fall out of the new index's dedupe once
   the old index is gone.
5. Client apps configure their own `google-services.json` / web push
   certificates from the same Firebase project.
