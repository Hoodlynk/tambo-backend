# Provisioning and device-first enrolment (B4)

**Audience:** partner integrators (OEM factories, BNPL point-of-sale systems,
fleet admins) and the Android engineers building the preinstalled app.

Some phones must be protected before anyone signs in: an OEM preinstall, a
BNPL handset leaving the shop, a fleet phone in a drawer. B4 handles them in
three steps:

```
partner system ──POST /partner/devices──▶ one provisioning token per handset
                                            │ (baked into the image or given
                                            ▼  to the phone at the till)
phone, no account ──POST /devices/claim──▶ ingest token: uploads evidence,
                                            │ can open an episode, the
                                            ▼ partner's recipients are alerted
person signs in on it ──POST /devices/:id/link──▶ the phone and its history
                                                   are now theirs
```

Partner API keys and the partner record are in
[partners-api.md](partners-api.md).

## 1. Provision: `POST /api/v1/partner/devices` (`X-Api-Key`)

```json
{
  "devices": [
    {
      "imeis": ["356938035643809"],
      "serial": "SN-1",
      "make": "Tecno",
      "deviceModel": "Spark 20",
      "name": "Shop demo"
    }
  ]
}
```

- Up to **500 handsets per call**, 1-2 IMEIs each; `serial` and `name` are
  optional (the name defaults to `"<make> <deviceModel>"`). An IMEI repeated
  within one call is a `400 validation_error`.
- The response has one result per row, in request order:

```json
{
  "devices": [
    {
      "deviceId": "665f…",
      "imeis": ["356938035643809"],
      "serial": "SN-1",
      "status": "provisioned",
      "provisioningToken": "9f2c…"
    }
  ]
}
```

| `status` | Meaning | Token? |
|---|---|---|
| `provisioned` | New device. | Yes |
| `reissued` | This partner already provisioned a handset sharing an IMEI, and the phone has not claimed. The new token replaces the old one, which stops working. | Yes |
| `claimed` | The phone already holds its ingest token. | No |

Factory re-runs are therefore safe: the same handset is never two devices.
Partners are isolated from each other, so the same IMEI under another partner
is a separate device. **Provisioning tokens are single-use and shown once;
only their hashes are stored.** The budget is the partner key's 600/h; one
call counts once, whatever its size.

## 2. Claim: `POST /api/v1/devices/claim` (no auth)

```json
{
  "provisioningToken": "9f2c…",
  "installId": "3b0e8f0e-5d0b-4a8e-9c55-0d6c2b8e1f7a",
  "integrityToken": "…"
}
```

→ `201 { device, ingestToken }`. From now on the phone behaves like any
enrolled phone: it uploads with `X-Device-Token`, and its failed-unlock
threshold can open an episode.

- **`installId`** is a random id the app generates once per install and keeps
  (16-128 of `A-Z a-z 0-9 . _ -`; a UUID works). If the claim response is
  lost, **the same install retries** and gets `200` with a fresh ingest token
  (the previous one stops working). Retrying is possible until the phone is
  linked. Any other install gets `409 device_already_claimed`, so a token
  copied off a factory sheet cannot take over a phone that is already in
  someone's hand.
- An unknown token and a suspended partner both answer
  `401 invalid_provisioning_token`.
- The limit is 30 per hour per IP.

### Play Integrity (`CLAIM_INTEGRITY`)

| Value | Behaviour |
|---|---|
| `off` (default) | The provisioning token alone is enough. |
| `required` | `integrityToken` is mandatory (`400 integrity_required`), and the verifier must accept it (`403 integrity_failed`; the phone stays claimable). The app binds `sha256("tambo-claim:<provisioningToken>:<installId>")` as the token request's hash, so a verdict cannot be replayed on another claim. |

The production verifier (decode the token with Google, check the package
name, the request hash and `MEETS_DEVICE_INTEGRITY`) is **not built yet**. To
avoid a placeholder that silently refuses every factory phone,
`CLAIM_INTEGRITY=required` **refuses to boot** outside development and test.
The seam is `src/services/integrity/`.

## While nobody owns the phone

- **Evidence** is stored with no `user`. Ingest advice (`trailCadenceSeconds`,
  `snapshotPolicy`) follows the **partner's `defaultPlan`**, which is the plan
  its owner will get at signup, so capture does not change when someone links
  the phone. With no default plan the advice is the free plan's.
- **An episode** opened by the threshold has no `user`. The first alert goes
  by email to the partner's **`alertRecipients`**, once per address per
  episode (the same dedupe as owner alerts). It includes the IMEIs, make and
  model, serial, last known location, the Tambo device id and how to resolve
  a false alarm. A suspended partner is still alerted. With no recipients
  configured, the episode opens and a warning is logged; nobody is mailed.
- **Owner surfaces** do not see the phone: every `/devices/:id…` route
  answers `404 device_not_found` and `/episodes` does not list it.
- **Push registration** (`POST /evidence/push-token`) answers
  `409 device_not_linked`: installs belong to an account, and with no owner
  nobody can send the phone a remote command.

### Partner resolve: `POST /api/v1/partner/devices/:id/mark-recovered` (`X-Api-Key`)

Closes the open episode on one of the partner's **unlinked** phones, for
example a false alarm in the shop or a handset back in stock. It returns
`200 { episode }`.

| Error | When |
|---|---|
| `404 device_not_found` | Unknown id, or another partner's phone. |
| `404 episode_not_found` | Nothing open. |
| `409 device_linked` | The phone has an owner, and only they can resolve it. |

## 3. Link: `POST /api/v1/devices/:id/link` (Bearer **and** `X-Device-Token`)

The person signed in on the phone takes ownership. Body: `{ "name"?: string }`
to rename the phone in the same call. → `200 { device }`, with `user` and
`linkedAt` set.

- **Both credentials are required.** The session says who; the device token
  proves they hold this phone's install. A device id alone would let anyone
  adopt any phone. A device token for a different phone than the path's
  answers `404 device_not_found`.
- **Idempotent** for the same account. Another account gets
  `409 device_already_linked`.
- **Refused while an episode is open** (`409 episode_open`). Whoever is
  holding a phone that has just failed its unlock threshold is exactly who
  must not become its owner. The partner resolves the episode first.
- **Gated like enrolment:** current terms and privacy acceptance
  (`403 legal_acceptance_required`) and the plan's device allowance
  (`409 device_limit`).
- The account **inherits the phone's history**: its resolved episodes and
  its evidence get the owner's id, so `/episodes`, packs and trails work as
  for any other device.
- Linking does **not** change the account's partner or plan. Whether linking
  a partner phone should grant the partner's `defaultPlan` is an open owner
  question (see the roadmap).
- The limit is 10 per hour per user.

### Partner read and events (B5)

`GET /api/v1/partner/devices/:id` shows a phone's claim, link and episode
state, and webhooks report `device.claimed`, `episode.opened` and
`episode.resolved` as they happen: [webhooks-api.md](webhooks-api.md).

## Device fields added

`serial`, `provisionedAt`, `claimedAt`, `linkedAt` appear on the device when
set. `user` is absent until the phone is linked. The provisioning token hash
and the install hash are never serialized.

A device needs an owner or a partner: the model refuses one with neither.
