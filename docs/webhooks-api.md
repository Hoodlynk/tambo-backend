# Partner webhooks and the partner device read (B5)

A partner system registers HTTPS endpoints with its API key
([partners-api.md](partners-api.md)) and hears about its fleet: episodes
opening and resolving, snapshot bursts arriving, provisioned phones claiming
their ingest token. Every request is HMAC-signed, retried with backoff and
recorded in a delivery log the partner can read.

All routes below take `X-Api-Key: tpk_...` and share the partner's budget of
600 calls per hour per key.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/partner/webhooks` | `{ url, events? }` → `201 { webhook, secret }`. **`secret` is shown once.** `409 webhook_limit` past 5 endpoints |
| GET | `/api/v1/partner/webhooks` | `{ webhooks }`, oldest first, never with the secret |
| DELETE | `/api/v1/partner/webhooks/:id` | `204`. The queue and delivery log go with it |
| POST | `/api/v1/partner/webhooks/:id/rotate-secret` | `{ webhook, secret }`. The old secret stops at once, queued retries included |
| POST | `/api/v1/partner/webhooks/:id/ping` | `202 { delivery }`. Sends a signed `ping` whatever the endpoint subscribes to |
| GET | `/api/v1/partner/webhooks/:id/deliveries` | `{ deliveries }`, newest first, last 50; the log keeps 30 days |
| GET | `/api/v1/partner/devices/:id` | `{ device, openEpisode }`, see below |

Another partner's endpoint id answers `404 webhook_not_found`, the same as an
unknown one.

- **`url`** must be `https` (max 500 characters). In production, an endpoint
  whose host resolves to a private, loopback, link-local, CGNAT or multicast
  address is refused **at send time**: the check runs on the address the
  socket actually connects to, so DNS rebinding cannot get around it.
  Redirects are not followed; a 3xx counts as a failure.
- **`events`** defaults to every event that exists today: `episode.opened`,
  `episode.resolved`, `snapshot.received`, `device.claimed`. Events added
  later are opt-in, so a handler never meets a type it did not ask for.

```json
{
  "webhook": {
    "id": "6650...",
    "url": "https://claims.acme.example/tambo",
    "events": ["episode.opened", "episode.resolved", "snapshot.received", "device.claimed"],
    "secretPrefix": "whsec_Ab12Cd",
    "createdAt": "2026-11-15T09:00:00.000Z"
  },
  "secret": "whsec_Ab12Cd...43 chars"
}
```

## What arrives

```
POST https://claims.acme.example/tambo
Content-Type: application/json
User-Agent: Tambo-Webhooks/1
Tambo-Event-Id: 849e1174-a825-44c8-a74b-d45ef8b4f1b6
Tambo-Event-Type: episode.opened
Tambo-Signature: t=1763197679,v1=5d41402abc4b2a76b9719d911017c592...

{
  "id": "849e1174-a825-44c8-a74b-d45ef8b4f1b6",
  "type": "episode.opened",
  "createdAt": "2026-11-15T09:07:59.692Z",
  "partner": "acme",
  "data": { ... }
}
```

| Type | `data` |
|---|---|
| `device.claimed` | `{ device }`: a provisioned phone traded its provisioning token for an ingest token. Not sent again when the same install retries the claim |
| `episode.opened` | `{ device, episode: { id, openedBy: "owner" \| "device", openedAt } }` |
| `episode.resolved` | `{ device, episode: { id, openedAt, resolvedAt, resolution } }` |
| `snapshot.received` | `{ device, episodeId, burst: { id, camera, trigger } }`, **once per burst** during an episode, however many frames arrive or in how many batches. A legacy single photo has `burst.id: null` |
| `ping` | `{ webhookId }` |

The **device** block is the same everywhere, including the device read:

```json
{
  "id": "6650...",
  "imeis": ["356938035643809"],
  "serial": "SN-1",
  "make": "Tecno",
  "deviceModel": "Spark 20",
  "status": "active | stolen",
  "provisioned": true,
  "claimedAt": "2026-11-15T09:00:00.000Z",
  "linked": false,
  "linkedAt": null
}
```

What a partner never receives: the owner's identity, the name the owner gave
the phone, any location, any photo. `imeis` is `null` on a phone a person
enrolled under the partner's code, because those were typed by the owner,
not supplied by the partner. This is the minimum while the data processing
agreement (decision W7 in [white-label-scoping.md](white-label-scoping.md))
is open.

Events cover every phone with the partner on it: provisioned phones, linked
or not, and phones people enrolled with `partnerCode`. A suspended partner
keeps receiving events for phones already in the field, as it keeps
receiving ownerless first alerts.

## Verifying the signature

`Tambo-Signature` is `t=<unix seconds>,v1=<hex HMAC-SHA256>`, where the HMAC
is keyed with the endpoint's secret over `"<t>.<raw request body>"`. Verify
against the **raw bytes**, before any JSON parsing, and reject a timestamp
more than five minutes old to stop replays.

```js
const crypto = require('crypto');

function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!match) return false;
  const [, t, v1] = match;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSeconds) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expected, 'hex'));
}
```

## Delivery

- **Any 2xx acknowledges.** Anything else, a timeout (10 s) or a network
  error is retried after 1 min, 5 min, 30 min, 2 h, 6 h, 12 h and 24 h:
  **8 attempts over about 45 hours**, then the delivery is `failed`.
- **At least once.** A retry carries the same body and the same
  `Tambo-Event-Id`; dedup on it. Order is not guaranteed: an
  `episode.resolved` can overtake an `episode.opened` that is being retried,
  so compare `openedAt` / `resolvedAt` rather than arrival order.
- **One event, one id, every endpoint.** When two endpoints subscribe to the
  same event they receive the same `Tambo-Event-Id`.
- **Never in the way.** Events are queued and sent after the request that
  caused them; a slow or failing endpoint never delays evidence ingest, an
  episode opening or a claim.
- **The log** (`GET .../deliveries`) shows `status`, `attempts`,
  `lastStatusCode`, `lastError` (`http_<status>`, `timeout`,
  `address_blocked`, `https_required`, or a network error code) and
  `nextAttemptAt` for each delivery.

The server sweeps due retries every 30 seconds, which also picks up first
attempts interrupted by a restart.

## The partner device read

```
GET /api/v1/partner/devices/:id      X-Api-Key: tpk_...
→ 200 {
  "device": { ...the device block above... },
  "openEpisode": { "id": "...", "openedAt": "...", "openedBy": "device" } | null
}
```

Any phone in the partner's fleet. Another partner's phone, or an unknown id,
answers `404 device_not_found`.

## Configuration

| Variable | Default | |
|---|---|---|
| `WEBHOOK_ALLOW_LOCAL_TARGETS` | `false` | `true` allows plain http and private addresses. **Development and test only**; any other environment refuses to boot |
| `WEBHOOK_TIMEOUT_MS` | `10000` | Per attempt |

## Storage

`PartnerWebhook` keeps the signing secret as-is (HMAC needs the secret
itself, so it cannot be hashed like an API key). It is never selected by
default and never serialized. Encrypting it at rest is filed in
[roadmap.md](roadmap.md). `WebhookDelivery` keeps each event body frozen at
enqueue so retries are byte-identical, deduped by a unique index on
(endpoint, event key), and expires after 30 days.
