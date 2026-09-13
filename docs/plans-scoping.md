# Plans / subscriptions scoping — Free, Pro, Family

**Status: entitlements BUILT (2026-09-13) — see [plans-api.md](plans-api.md);
billing rails still open.** Decision taken 2026-09-13: **Play Billing first**
(M-PESA only if a direct-sales channel materialises); the webhook build (3b)
waits on the Play Console service account. Original scoping below.

## What the screens promise (the entitlement matrix)

| Entitlement | Free | Pro | Family |
|---|---|---|---|
| Unlock logging | ✓ | ✓ | ✓ |
| Event history | 7 days | Unlimited* | Unlimited* |
| Real-time intruder alerts (push) | — | ✓ | ✓ |
| Location pings ("every minute") | — | ✓ | ✓ |
| Devices | 1 | 1 | up to 5 |
| Shared dashboard | — | — | ✓ |
| Support | Email | Priority | Premium |

\* "Unlimited" still bounded by evidence retention (90d routine / 365d episode)
— that is a safety/privacy policy, not a plan perk. The Plans screen should say
"full history" rather than promise indefinite storage.

## Proposed backend design

### 1. Plan + entitlements (build first, billing later)

- `User.plan: 'free' | 'pro' | 'family'` (default `'free'`) +
  `planExpiresAt?: Date` (absent = never, for free).
- One `entitlements.ts` module — the single lookup the rest of the code asks
  (`entitlements(user).maxDevices`, `.historyDays`, `.trailCadenceSeconds`).
  No plan checks scattered through services.
- Enforcement points (each is one guard in an existing service):
  - device registration → `maxDevices` (today: unlimited; would become 1/1/5),
  - activity/log reads → `historyDays` window on queries,
  - trail cadence → server-side advisory in the ingest response (the phone
    asks "how often should I ping?"), not a hard reject — evidence is never
    refused during a theft.
- `GET /api/auth/me` (or a `/api/v1/plan` endpoint) returns plan + entitlements
  so the Settings "Subscription: Free plan" row reads real data.

### 2. Billing rails (the real decision)

| | Google Play Billing | M-PESA (Daraja) | Both |
|---|---|---|---|
| Fit | Mandatory for in-app digital subscriptions distributed via Play | The payment method most KE users actually have | Play for the store build, M-PESA for direct/web sales |
| Server work | Verify purchases + Real-Time Developer Notifications (RTDN) webhook | STK push + callback webhook + reconciliation + our own renewal engine | Both, plus an abstraction |
| Recurring | Native subscriptions | No native recurring — we build renewal nudges/grace | — |
| Fees | 15% (subscriptions ≤$1M/yr) | ~KES transaction fees | — |

**Recommendation:** Play Billing first — an Android-only app distributed via
Play has little choice for in-app subscriptions, and it gives us renewals,
grace periods, and refunds for free. M-PESA as phase 2 only if a
direct-sales/web channel materialises. Either way the backend's job is the
same shape: a webhook flips `user.plan`/`planExpiresAt`; entitlements read it.

### 3. Family specifics

"Up to 5 devices + shared dashboard" implies an owner→member relation. The
buddy system is NOT that (buddies are alert recipients, not co-owners). Scope
a `FamilyGroup { owner, members[] }` later — do not overload buddies.

### Open questions

- Do Pro entitlements apply per-account or per-device? (Recommend: account.)
- Trial period? Play Billing supports free trials natively.
- What does "priority/premium support" mean operationally before there is a
  support team? Suggest the screens soften this until it exists.
