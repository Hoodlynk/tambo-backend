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

## What gets pushed

| Event | Content | Recipients |
|---|---|---|
| First alert (episode opens) | title "Tambo alert: … may be stolen", `data: { type: "first_alert", episodeId }` | owner + accepted buddies, **once per human per episode** (multicast to all their devices) |
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

## Operator setup (human action)

1. Create a Firebase project; enable Cloud Messaging.
2. Generate a service-account key (Project settings → Service accounts).
3. `FCM_SERVICE_ACCOUNT_JSON=$(base64 < service-account.json)` and
   `PUSH_DRIVER=fcm`. A typo'd driver, missing credential, or corrupt base64
   refuses to boot.
4. Deploy note (first deploy with push): the first-alert unique index changed
   to include `channel`; mongoose creates the new index at boot but never
   drops the old `{episode, recipient, kind}` one - drop it manually once.
5. Client apps configure their own `google-services.json` / web push
   certificates from the same Firebase project.
