# Partners, white-label config and the launch handshake (B3)

The foundation every white-label partner plugs into (scoping:
[white-label-scoping.md](white-label-scoping.md)). B3 builds four things:

1. **Partners**: a catalogue managed by Tambo admins.
2. **Partner API keys**: machine credentials for partner systems. B4
   provisioning and B5 webhooks mount behind them.
3. **`GET /api/v1/client/config`**: the app's launch handshake, covering
   update policy, brand theme and feature flags.
4. **`partnerCode`** at signup and device enrolment, `planSource` on plans,
   and the `X-Client-*` headers recorded on sessions.

## The partner record

```json
{
  "_id": "665f...",
  "code": "acme",
  "name": "Acme Insurance",
  "type": "oem | insurer | telco | enterprise | bnpl",
  "status": "active | suspended",
  "brand": {
    "displayName": "Acme Protect",
    "logoUrl": "https://...",
    "colors": { "primary": "#0A7F3F", "onPrimary": "#FFFFFF" },
    "supportUrl": "https://...",
    "supportEmail": "help@acme.example"
  },
  "features": { "buddies": true, "plans": true, "familiarLocations": true },
  "defaultPlan": "pro",
  "alertRecipients": [{ "email": "claims@acme.example", "name": "Claims desk" }]
}
```

- **`code`** is the public handle. It is 2-32 characters of lowercase letters,
  digits or hyphens, and input is normalized (`" ACME "` → `acme`). It is
  **immutable**: branded builds and existing signups carry it.
- **`brand`** URLs must be https. Colours are `#RRGGBB` and are stored in
  upper case.
- **`features`** lists what a partner may hide. **Evidence upload is not on
  the list and never will be.** The flags shape the client UI only; the
  server does not refuse buddy or plan calls for a partner's users.
- **`defaultPlan`** is granted at signup with `planSource: "partner"`.
  Omitted or `free` means no grant.
- **`alertRecipients`** (at most 5) receive the first alert for an episode
  on a partner phone nobody has linked yet
  ([provisioning-api.md](provisioning-api.md)). Webhooks are separate:
  the partner registers its own endpoints ([webhooks-api.md](webhooks-api.md)).
- **`suspended`** refuses new signups and enrolments under the code, and
  every API key stops working. Branding **keeps serving**, so phones already
  in the field do not repaint as Tambo mid-life.

## Admin catalogue (Bearer, `admin` role)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/v1/admin/partners` | `201 { partner }`. `409 partner_code_taken` |
| GET | `/api/v1/admin/partners` | `{ partners }`, newest first |
| GET | `/api/v1/admin/partners/:id` | `404 partner_not_found` |
| PATCH | `/api/v1/admin/partners/:id` | `features` merges flag by flag; `brand` and `alertRecipients` replace whole; `defaultPlan: null` stops future grants (existing accounts keep theirs); `code` is ignored |
| POST | `/api/v1/admin/partners/:id/keys` | `{ name }` → `201 { key, apiKey }`. **`apiKey` is shown once** |
| GET | `/api/v1/admin/partners/:id/keys` | `{ keys }`, revoked keys included |
| DELETE | `/api/v1/admin/partners/:id/keys/:keyId` | `204`, idempotent. `404 partner_key_not_found`, including for a key that belongs to a different partner |

Issuing and revoking keys is recorded in the admin's own security trail
(`partner_key_issued`, `partner_key_revoked`, with the key prefix and never
the key itself).

**Before the first key goes to a real partner**, the owner needs the data
processing agreement (decision W7 in
[white-label-scoping.md](white-label-scoping.md)).

## Partner systems (`X-Api-Key`)

Keys look like `tpk_<43 base64url chars>`. Only the SHA-256 hash is stored,
plus a 12-character `prefix` so a key can be identified in a list. A partner
key is accepted only on `/api/v1/partner/*`, and a user JWT is never
accepted there.

```
GET /api/v1/partner/me        X-Api-Key: tpk_...
→ 200 { "partner": { "code": "acme", "name": "Acme Insurance", "type": "insurer" } }
```

B4 adds `POST /api/v1/partner/devices` (bulk provisioning) and
`POST /api/v1/partner/devices/:id/mark-recovered` under the same key and
budget; see [provisioning-api.md](provisioning-api.md). B5 adds
`GET /api/v1/partner/devices/:id` and `/api/v1/partner/webhooks*`; see
[webhooks-api.md](webhooks-api.md).

`GET /partner/me` is an integration check: it confirms the key is live and shows
which partner it belongs to. Error codes are `401 missing_api_key` and
`401 invalid_api_key` (the key is unknown or revoked, or the partner is
suspended). The limit is 600 calls per hour per key.

## The launch handshake

```
GET /api/v1/client/config?platform=android|ios|web[&partner=acme]
X-Client-Version: 1.4.0      (optional)
```

```json
{
  "config": {
    "platform": "android",
    "versions": { "minimum": "1.2.0", "recommended": "1.4.0", "update": "none" },
    "partner": { "code": "acme", "name": "Acme Insurance", "type": "insurer" },
    "brand": {
      "displayName": "Acme Protect", "logoUrl": "https://...",
      "colors": { "primary": "#0A7F3F", "onPrimary": "#FFFFFF" },
      "supportUrl": null, "supportEmail": "help@acme.example"
    },
    "features": { "buddies": false, "plans": true, "familiarLocations": true }
  }
}
```

- The endpoint is public, because the app calls it before anyone signs in.
  It sends `Cache-Control: public, max-age=300` and `Vary: X-Client-Version`.
  The limit is 1200 calls per hour per IP: carrier NAT puts many phones
  behind one address.
- **`versions.update`** compares the request's `X-Client-Version` with the
  policy:
  - `required`: block the app behind an update screen.
  - `recommended`: show a dismissible nudge.
  - `none`: nothing to do.
  - `unknown`: the header was missing or malformed.
- If `partner` is omitted, the response carries the Tambo brand (`#1D28D6`
  on `#FFFFFF`) and every feature on. An unknown code returns
  `404 unknown_partner`, deliberately: a branded build with a typo should
  fail in QA rather than ship painted as Tambo.
- One binary serves every brand. A store build carries only its partner code,
  per decision W1's default.

### Version policy (env)

| Variable | Default |
|---|---|
| `CLIENT_MIN_VERSION_ANDROID` / `_IOS` / `_WEB` | `0.0.0` (no policy) |
| `CLIENT_RECOMMENDED_VERSION_ANDROID` / `_IOS` / `_WEB` | `0.0.0` |

Versions are compared numerically (`1.10.0` > `1.9.0`). A malformed value, or
a minimum above the recommended version, **refuses to boot**.

## `partnerCode` at signup and enrolment

- `POST /auth/register` accepts `partnerCode`. The account joins that
  partner, and if the partner has a `defaultPlan` the account gets it with
  `planSource: "partner"`. Unknown and suspended codes both return
  `400 unknown_partner`, and nothing is written. A registration that
  supersedes an abandoned signup also re-decides the partner.
- `POST /devices` accepts `partnerCode`, and the device joins that fleet.
  When the field is omitted, the device inherits the owner's partner. The
  partner is fixed at enrolment and is not part of `PATCH /devices/:id`.
- `user.partner` and `device.partner` are ids on the existing payloads.

## `planSource`

`GET /plan` now returns `source: "self" | "partner"`. The admin
`PATCH /plan/:userId` accepts `source` (default `self`). **Rule for the Play
Billing webhook (roadmap 3b):** it must leave alone any account whose
`planSource` is `partner` while that plan is in force.

## `X-Client-Platform` / `X-Client-Version`

Every request from a current client carries both headers
(`android | ios | web`, `X.Y.Z`). They are **advisory**: a missing or
malformed value is dropped and never rejected, so old builds keep working
and a stolen phone's upload never fails over a header. Login, OTP verify and
password reset record both values on the session. A refresh updates them,
and keeps the previous values when the headers are absent.
`GET /auth/sessions` shows them as `clientPlatform` and `clientVersion`.

## Not in B3

The following are filed in [roadmap.md](roadmap.md):

- **Per-partner legal documents.** Overriding terms and privacy needs
  per-partner versions in the acceptance flow.
- **Server-side enforcement of feature flags.**
- **Expiry for partner-granted plans.**
- Provisioning and device-first enrolment landed in B4
  ([provisioning-api.md](provisioning-api.md)); webhooks and the partner
  device read in B5 ([webhooks-api.md](webhooks-api.md)).
