# Remote commands API (B2)

While a device is marked stolen, its owner can ask it to do three things:
take a **snapshot** burst, report a **location** fix, or **ring**. This page
is the contract for both sides: the owner's app that issues commands, and
the protected phone that carries them out.

## The model in one paragraph

A command is bound to the device's **open episode**. There are no commands
outside an incident, so the feature can never become a standing way to watch
a phone or whoever is holding it. The phone learns about a command in one of
three ways: a silent FCM data message that wakes it, the `pendingCommands`
list on every ingest reply, or an explicit poll. It answers with **ordinary
evidence envelopes** whose payload carries `commandId`. That means the
answer is hashed, server-timestamped and in the pack like all other
evidence. Delivery is **at-least-once**: an outstanding command keeps being
handed over until it is answered, cancelled or expired, and the phone
dedups on `id`.

```
owner app ── POST /devices/:id/commands ──► DeviceCommand (pending)
                                               │
                         FCM data push ◄───────┤ wake (if a device push token exists)
                                               │
phone ── GET /evidence/commands ───────────────┤ → delivered (first hand-over)
phone ── POST /evidence (pendingCommands) ─────┘
phone ── POST /evidence { payload: {commandId, ...} } → completed | failed
```

## Owner side (Bearer)

### `POST /api/v1/devices/:id/commands`

```json
{ "type": "snapshot", "cameras": ["front"] }
{ "type": "locate" }
{ "type": "ring", "durationSeconds": 60 }
```

| Field | Applies to | Default | Bounds |
|---|---|---|---|
| `type` | all | (required) | `snapshot`, `locate`, `ring` |
| `cameras` | snapshot only | `["front", "back"]` | 1-2, each once |
| `durationSeconds` | ring only | 30 | 5-120 |

Sending a field with the wrong type is a `validation_error`, not a silent
drop.

- **201** `{ command }` when this call issued it.
- **200** `{ command }` when a command of the same type is still outstanding.
  Repeated taps converge on it, keeping its original parameters and expiry,
  and the wake-up push is sent again.
- **409 `episode_not_open`**: mark the device stolen first.
- **409 `device_token_revoked`**: the device has no ingest token, so it
  could never poll.
- 404 `device_not_found`, 429 `rate_limited` (30 per hour per user).

### `GET /api/v1/devices/:id/commands`

The device's 50 most recent commands, newest first, each with its status:

| Status | Meaning |
|---|---|
| `pending` | Issued; the phone has not fetched it yet |
| `delivered` | Handed to the phone at least once (`deliveredAt` = first time) |
| `completed` | An answering envelope arrived (`completedAt`, `resultCount`) |
| `failed` | The phone reported it could not do it (`failureReason`) |
| `cancelled` | By the owner, or because the episode resolved |
| `expired` | Still unanswered past `expiresAt`; derived from the clock, never stored |

Lifetimes: snapshot and locate **30 minutes** (a fix or photo from a phone
that was offline a while is still wanted), ring **5 minutes** (a late ring is
noise). Policy lives in `src/config/commands.ts`.

### `POST /api/v1/devices/:id/commands/:commandId/cancel`

Cancels an outstanding command. It is idempotent: a command that already
finished or was already cancelled comes back unchanged with 200. Returns
404 `command_not_found` for an unknown id or another device's command.

Resolving the episode (`mark-recovered`) cancels everything outstanding, so
a recovered phone never acts on a stale request.

## Phone side (X-Device-Token)

### Register for wake-ups: `POST /api/v1/evidence/push-token`

`{ "token": "<FCM token>", "platform": "android" }`, on every app start and
on every FCM token rotation. It authenticates with the **ingest token**, so
it keeps working after the owner's sessions are revoked. The row stays on
the owner's account, so the install still gets the owner's other alerts,
**except theft alerts about this same device**. The thief holding it must
not see "your phone may be stolen" on its lock screen. Limit: 30 per hour
per device.

### The wake-up push

A data-only FCM message (no banner), sent at Android high priority so it
gets through Doze:

```json
{ "type": "device_command", "commandId": "665f...", "commandType": "ring" }
```

It carries no parameters. Treat it as "poll now" and act on what the poll
returns. That response is authenticated with the device's own token.

### `GET /api/v1/evidence/commands`

```json
{ "commands": [
  { "id": "665f...", "type": "ring", "params": { "durationSeconds": 30 },
    "issuedAt": "2026-11-13T14:02:00.000Z", "expiresAt": "2026-11-13T14:07:00.000Z" }
] }
```

Outstanding commands, oldest first. The same objects also arrive as
`pendingCommands` on any ingest reply while an episode is open (absent when
there are none). Poll on a wake-up push and on the trail timer. Limit: 360
per hour per device.

Rules for the phone:

1. **Dedup on `id`.** The same command arrives again until its answer lands.
2. **Ignore anything past `expiresAt`** by the device clock. The server
   stops sending it anyway.
3. **Answer through the normal envelope queue**, never a side channel.

### Answering

Put `commandId` in the payload of the envelopes that carry the result:

| Command | Answer with |
|---|---|
| snapshot | The burst's `PHOTO` envelopes (`trigger: "owner_request"`, plus `commandId`), then their media as usual |
| locate | A `TRAIL_POINT` with the fix and `commandId` |
| ring | A `STATUS` envelope `{ "commandId": "...", "rang": true }` once it has rung |

If the command cannot be carried out:

```json
{ "commandId": "665f...", "outcome": "failed", "reason": "camera_unavailable" }
```

as a `STATUS` envelope. `reason` is a short slug (`[\w-]{1,64}`); anything
else is dropped.

How the server applies answers:

- The first result completes the command, even after expiry or an earlier
  failure report, because the phone managed it after all. `resultCount`
  counts first receipts only, so retried duplicates do not inflate it.
- A failure report fails a command only while it is still outstanding.
- A cancelled command stays cancelled, but its answering evidence is still
  stored and counted.
- A `commandId` naming **another device's** command is ignored. The envelope
  is kept as ordinary evidence, but it is not linked to that command and
  does not complete it.

## Data and retention

`DeviceCommand` rows have no TTL. They are the incident's audit trail and
live as long as the device's episodes do. Removing the device deletes both,
and unbinds (but keeps) the device's push token. Envelopes that answer a
command carry a verified `commandId` column, a read model beside the burst
columns. The payload remains the evidence.

## Not built yet

- No owner push when a command completes; the app re-reads the list.
- Commands are not listed in the pack. Their answers are, as evidence.
- Remote commands are not plan-gated. Whether they should be is an open owner
  decision (roadmap).
