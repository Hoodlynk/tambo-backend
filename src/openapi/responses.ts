import { z } from 'zod';
import { AUTH_EVENT_TYPES } from '../models/authEvent.model';
import {
  COMMAND_CAMERAS,
  COMMAND_STATUSES,
  COMMAND_TYPES,
} from '../models/deviceCommand.model';
import {
  SNAPSHOT_CAMERAS,
  SNAPSHOT_TRIGGERS,
} from '../models/evidenceEnvelope.model';
import { OTP_PURPOSES } from '../models/otpChallenge.model';
import { PARTNER_STATUSES, PARTNER_TYPES } from '../models/partner.model';
import { WEBHOOK_EVENTS } from '../models/partnerWebhook.model';
import { CLIENT_PLATFORMS } from '../config/client';
import { PUSH_PLATFORMS } from '../models/pushToken.model';
import { PLAN_SOURCES, USER_PLANS } from '../models/user.model';

/**
 * Response-body schemas for the OpenAPI document. Requests are described by
 * the validation schemas (src/validation/*) - the same objects the server
 * enforces - so only responses need describing here. Dates are ISO-8601
 * strings on the wire; Mongo ids are 24-hex strings.
 *
 * Objects are loose (additionalProperties allowed) on purpose: adding a field
 * is a non-breaking change and must not invalidate older generated clients.
 */

const isoDate = z.string().describe('ISO-8601 timestamp');
const objectId = z.string().regex(/^[a-f\d]{24}$/i);

// --- The error envelope (every non-2xx response) -----------------------------

export const errorResponse = z
  .looseObject({
    code: z
      .string()
      .describe(
        'Stable machine-readable code. Branch on this, never on message.',
      ),
    message: z.string().describe('Human wording; free to change.'),
    details: z
      .array(z.object({ field: z.string(), message: z.string() }))
      .optional()
      .describe('Per-field errors; present on validation_error only.'),
    retryAfter: z
      .number()
      .optional()
      .describe('Seconds to wait; present on rate_limited (429) only.'),
  })
  .describe('The uniform error envelope.');

// --- Auth --------------------------------------------------------------------

export const user = z.looseObject({
  _id: objectId,
  name: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  role: z.enum(['user', 'admin']),
  partner: objectId
    .optional()
    .describe('The white-label partner the account signed up under.'),
  emailVerifiedAt: isoDate.optional(),
  phoneVerifiedAt: isoDate.optional(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const tokens = z.object({
  accessToken: z
    .string()
    .describe('JWT; send as "Authorization: Bearer <token>".'),
  refreshToken: z
    .string()
    .describe('Opaque, single-use; rotated on every /auth/refresh.'),
  expiresIn: z
    .string()
    .describe('Access-token TTL as a duration string, e.g. "15m".'),
});

export const authResponse = z.object({ user, tokens });

/** The web (PWA) surface: refresh token travels in an httpOnly cookie, not here. */
export const webAuthResponse = z.object({
  user,
  tokens: z.object({
    accessToken: z.string().describe('Hold in memory only - never in storage.'),
    expiresIn: z.string(),
  }),
});

export const challenge = z.object({
  challengeId: objectId,
  purpose: z.enum(OTP_PURPOSES),
  expiresInMinutes: z.number(),
});

/** A 6-digit code was emailed; the next move is POST /auth/otp/verify. */
export const challengeResponse = z.object({ challenge });

export const meResponse = z.object({ user });

export const sessionsResponse = z.object({
  sessions: z.array(
    z.object({
      id: objectId,
      userAgent: z.string().nullable(),
      clientPlatform: z
        .enum(CLIENT_PLATFORMS)
        .nullable()
        .describe('From X-Client-Platform; null when never sent.'),
      clientVersion: z
        .string()
        .nullable()
        .describe('From X-Client-Version; updated on every refresh.'),
      createdAt: isoDate,
      expiresAt: isoDate,
      current: z
        .boolean()
        .describe('True for the session making this request.'),
    }),
  ),
});

export const securityEventsResponse = z.object({
  events: z.array(
    z.object({
      type: z.enum(AUTH_EVENT_TYPES),
      at: isoDate,
      ip: z.string().optional(),
      userAgent: z.string().optional(),
      meta: z.looseObject({}).optional(),
    }),
  ),
});

// --- Devices & episodes --------------------------------------------------------

export const device = z.looseObject({
  _id: objectId,
  user: objectId
    .optional()
    .describe('Absent on a provisioned phone nobody has linked yet.'),
  name: z.string(),
  imeis: z.array(z.string()),
  make: z.string(),
  deviceModel: z.string(),
  colour: z.string().optional(),
  purchaseInfo: z.string().optional(),
  failedUnlockThreshold: z.number(),
  status: z.enum(['active', 'stolen']),
  partner: objectId
    .optional()
    .describe('The partner fleet the phone was enrolled under.'),
  serial: z.string().optional().describe('Partner-supplied hardware serial.'),
  provisionedAt: isoDate
    .optional()
    .describe('Set when a partner provisioned the phone.'),
  claimedAt: isoDate
    .optional()
    .describe('When the provisioned phone claimed its ingest token.'),
  linkedAt: isoDate
    .optional()
    .describe('When a person linked the provisioned phone to their account.'),
  installId: z
    .string()
    .optional()
    .describe('The app install that enrolled the phone, when it sent one.'),
  lastSeenAt: isoDate
    .optional()
    .describe('Server time of the last upload or heartbeat.'),
  suspiciousAt: isoDate
    .optional()
    .describe(
      'Latest failed unlock or locked-screen boot not yet followed by a ' +
        'successful unlock; arms the "went quiet" alert.',
    ),
  quietAlertedAt: isoDate
    .optional()
    .describe('When the owner was last told the phone went quiet.'),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const deviceResponse = z.object({ device });
export const devicesResponse = z.object({ devices: z.array(device) });

export const deviceWithTokenResponse = z.object({
  device,
  ingestToken: z
    .string()
    .describe('Shown ONCE; only its hash is stored. Send as X-Device-Token.'),
});

export const ingestTokenResponse = z.object({ ingestToken: z.string() });

const location = z.object({
  lat: z.number(),
  lng: z.number(),
  accuracyM: z.number().optional(),
});

export const activityResponse = z.object({
  activity: z.object({
    inWindow: z.number().describe('Failed unlocks inside the counting window.'),
    toThreshold: z
      .number()
      .describe('Attempts left before auto-open; 0 = would open.'),
    threshold: z.number(),
    windowMinutes: z.number(),
    historyDays: z
      .number()
      .nullable()
      .describe(
        "How far back `recent` reaches under the owner's plan; null = full. " +
          'Show "last N days" instead of looking broken.',
      ),
    lastAttemptAt: isoDate.nullable(),
    recent: z.array(
      z.object({
        capturedAt: isoDate.describe('Device clock; recorded, never trusted.'),
        receivedAt: isoDate.describe(
          'Server clock; the authoritative timeline.',
        ),
        location: location.nullable(),
      }),
    ),
  }),
});

export const episode = z.looseObject({
  _id: objectId,
  user: objectId
    .optional()
    .describe('Absent while the device has no owner (partner-provisioned).'),
  device: objectId,
  status: z.enum(['open', 'resolved']),
  openedBy: z.enum(['owner', 'device', 'buddy']),
  openedAt: isoDate,
  resolvedAt: isoDate.optional(),
  resolution: z.string().optional(),
  note: z.string().optional(),
  reportedBy: objectId
    .optional()
    .describe("The buddy who reported it, when openedBy is 'buddy'."),
});

export const episodeResponse = z.object({ episode });
export const episodesResponse = z.object({ episodes: z.array(episode) });

export const trailResponse = z.object({
  trail: z.object({
    movement: z
      .enum(['static', 'moving', 'unknown'])
      .describe('unknown = fewer than 2 usable fixes.'),
    points: z.array(
      z.object({
        at: isoDate.describe('Server receipt time - the authoritative clock.'),
        capturedAt: isoDate.describe(
          "The device's claimed capture time - shown, never trusted.",
        ),
        source: z
          .enum(['UNLOCK_FAILED', 'TRAIL_POINT', 'PHOTO'])
          .describe('PHOTO = a snapshot frame that carried a location.'),
        lat: z.number(),
        lng: z.number(),
        accuracyM: z.number().optional(),
        familiar: z
          .object({ label: z.string(), distanceM: z.number() })
          .nullable(),
      }),
    ),
    leftFamiliar: z
      .object({ label: z.string(), at: isoDate })
      .nullable()
      .describe('Set only when a MOVING trail left a familiar place.'),
  }),
});

export const pack = z.looseObject({
  version: z.literal(1),
  generatedAt: isoDate,
  episode: z.looseObject({ id: objectId, status: z.string() }),
  owner: z.looseObject({ name: z.string() }),
  device: z.looseObject({ name: z.string(), imeis: z.array(z.string()) }),
  unlockAttempts: z.array(z.looseObject({})),
  trail: z.array(z.looseObject({})),
  trailSummary: z.looseObject({
    movement: z.enum(['static', 'moving', 'unknown']),
    pointsWithoutFix: z.number(),
  }),
  snapshotSets: z
    .array(z.looseObject({}))
    .describe('Camera bursts in receipt order; see /episodes/{id}/snapshots.'),
  photos: z
    .array(z.looseObject({}))
    .describe('Every frame, flat. Prefer snapshotSets.'),
  actionChecklist: z.array(z.string()),
  integrity: z.looseObject({
    algorithm: z.literal('Ed25519'),
    publicKeyBase64: z.string(),
    signatureBase64: z.string(),
  }),
});

export const packResponse = z.object({ pack });

const snapshotCamera = z.enum(SNAPSHOT_CAMERAS);
const snapshotTrigger = z.enum(SNAPSHOT_TRIGGERS);

export const snapshotsResponse = z.object({
  snapshots: z.object({
    summary: z.object({
      bursts: z.number(),
      frames: z.number(),
      framesWithMedia: z
        .number()
        .describe('Frames whose bytes have arrived; the rest are pending.'),
    }),
    bursts: z.array(
      z.object({
        burstId: z.string(),
        trigger: snapshotTrigger,
        at: isoDate.describe('Server receipt time of the first frame.'),
        capturedAt: isoDate.describe(
          "The device's claim - shown, never trusted.",
        ),
        location: location.extend({ mapsLink: z.string() }).nullable(),
        familiar: z
          .object({ label: z.string(), distanceM: z.number() })
          .nullable(),
        expectedFrames: z
          .number()
          .nullable()
          .describe('What the device said the burst would hold.'),
        cameras: z.object({
          front: z.number(),
          back: z.number(),
          unknown: z.number(),
        }),
        frames: z.array(
          z.object({
            envelopeId: z.string(),
            seq: z.number().nullable(),
            camera: snapshotCamera,
            receivedAt: isoDate,
            capturedAt: isoDate,
            sha256: z.string().describe('Media hash once bytes landed.'),
            bytes: z.number().optional(),
            contentType: z.string().optional(),
            hasMedia: z.boolean(),
            headingDeg: z.number().optional(),
            mediaPath: z
              .string()
              .describe(
                'Relative path of GET /episodes/{id}/snapshots/{envelopeId}.',
              ),
          }),
        ),
      }),
    ),
  }),
});

export const snapshotPolicy = z
  .object({
    framesPerCamera: z.number(),
    intervalSeconds: z.number(),
    maxBurstsPerEpisode: z.number(),
  })
  .describe(
    'Advisory camera-burst policy for the plan. Advice on how much to ' +
      'capture; evidence is never refused.',
  );

export const packSendResponse = z.object({
  recipients: z.array(z.string()).describe('Email addresses the pack went to.'),
});

// --- Remote commands (B2) -----------------------------------------------------------

export const deviceCommand = z
  .looseObject({
    id: objectId.describe('Dedup on this: delivery is at-least-once.'),
    type: z.enum(COMMAND_TYPES),
    params: z.looseObject({
      cameras: z
        .array(z.enum(COMMAND_CAMERAS))
        .optional()
        .describe('snapshot: the cameras to fire.'),
      durationSeconds: z
        .number()
        .optional()
        .describe('ring: how long to ring.'),
    }),
    issuedAt: isoDate,
    expiresAt: isoDate.describe('Do not act on the command after this.'),
  })
  .describe(
    'A command as the device sees it. Answer with evidence envelopes whose ' +
      'payload carries "commandId" (and "outcome": "failed" plus "reason" ' +
      'when it could not be done).',
  );

export const ownerCommand = deviceCommand
  .extend({
    deviceId: objectId,
    episodeId: objectId,
    status: z
      .enum([...COMMAND_STATUSES, 'expired'])
      .describe(
        'pending -> delivered -> completed | failed; cancelled by the owner ' +
          'or when the episode resolves; expired once past expiresAt unanswered.',
      ),
    resultCount: z
      .number()
      .describe('Answering envelopes received (a snapshot sends several).'),
    deliveredAt: isoDate.optional(),
    completedAt: isoDate.optional(),
    failedAt: isoDate.optional(),
    failureReason: z.string().optional(),
    cancelledAt: isoDate.optional(),
  })
  .describe('A command as the owner sees it, with where it got to.');

export const commandResponse = z.object({ command: ownerCommand });
export const commandsResponse = z.object({ commands: z.array(ownerCommand) });
export const deviceCommandsResponse = z.object({
  commands: z
    .array(deviceCommand)
    .describe('Outstanding commands, oldest first; empty when none.'),
});

// --- Evidence ingest (device-token auth) -----------------------------------------

export const ingestResponse = z.object({
  results: z.array(
    z.object({
      id: z.string().describe('The client-generated envelope id.'),
      status: z.enum(['acked', 'duplicate', 'rejected']),
      reason: z.string().optional(),
    }),
  ),
  episodeId: objectId
    .optional()
    .describe('Present when the device has an open episode after this batch.'),
  episodeOpened: z
    .boolean()
    .optional()
    .describe('True when THIS batch crossed the threshold. Start the trail.'),
  trailCadenceSeconds: z
    .number()
    .optional()
    .describe(
      'Advisory TRAIL_POINT interval while an episode is open, tuned to the ' +
        "owner's plan. Advice only - evidence is never refused.",
    ),
  snapshotPolicy: snapshotPolicy.optional(),
  pendingCommands: z
    .array(deviceCommand)
    .optional()
    .describe(
      'Outstanding remote commands, oldest first; absent when none. Re-sent ' +
        'until answered - dedup on id.',
    ),
});

export const mediaAckResponse = z.object({
  envelopeId: z.string(),
  bytes: z.number(),
  stored: z
    .boolean()
    .describe('False = this exact content was already stored.'),
});

// --- Buddies -----------------------------------------------------------------------

export const buddyOwnerView = z.object({
  id: objectId,
  email: z.string(),
  name: z.string().nullable(),
  status: z.enum(['pending', 'active', 'declined', 'revoked']),
  invitedAt: isoDate,
  respondedAt: isoDate.optional(),
});

export const buddyCreatedResponse = z.object({
  buddy: z.object({
    id: objectId,
    email: z.string(),
    status: z.enum(['pending', 'active', 'declined', 'revoked']),
  }),
});

export const buddiesResponse = z.object({ buddies: z.array(buddyOwnerView) });

export const protectedResponse = z.object({
  people: z.array(
    z.object({
      owner: z.object({ id: objectId, name: z.string() }),
      devices: z.array(
        z.object({
          id: objectId,
          name: z.string(),
          make: z.string(),
          deviceModel: z.string(),
          status: z.enum(['active', 'stolen']),
        }),
      ),
    }),
  ),
});

export const buddyReportResponse = z.object({
  episode: z
    .object({
      id: objectId,
      status: z.enum(['open', 'resolved']),
      openedAt: isoDate,
    })
    .describe("Proof it worked, not the owner's incident record."),
});

export const heartbeatResponse = z.object({
  ok: z.literal(true),
  episodeId: objectId
    .optional()
    .describe('Present while a theft episode is open for this device.'),
});

export const invitesResponse = z.object({
  invites: z.array(
    z.object({
      id: objectId,
      from: z.object({ name: z.string() }).nullable(),
      status: z.enum(['pending', 'active', 'declined', 'revoked']),
      invitedAt: isoDate,
    }),
  ),
});

export const inviteResponseResponse = z.object({
  invite: z.object({ id: objectId, status: z.string() }),
});

// --- Familiar locations ---------------------------------------------------------------

export const familiarLocation = z.looseObject({
  _id: objectId,
  user: objectId,
  label: z.string(),
  lat: z.number(),
  lng: z.number(),
  radiusM: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const familiarLocationResponse = z.object({
  location: familiarLocation,
});
export const familiarLocationsResponse = z.object({
  locations: z.array(familiarLocation),
});

// --- Plan --------------------------------------------------------------------------------

const planName = z.enum(USER_PLANS);

export const planResponse = z.object({
  plan: z.object({
    plan: planName,
    effectivePlan: planName.describe(
      'What is in force NOW (lapsed paid = free).',
    ),
    expiresAt: isoDate.nullable(),
    source: z
      .enum(PLAN_SOURCES)
      .describe(
        '"partner" = paid for by a white-label partner; store billing never overwrites it.',
      ),
    entitlements: z.object({
      maxDevices: z.number(),
      historyDays: z
        .number()
        .nullable()
        .describe('null = full history (bounded only by evidence retention).'),
      trailCadenceSeconds: z.number(),
      pushAlerts: z.boolean(),
      snapshotPolicy,
    }),
  }),
});

// --- Push tokens ---------------------------------------------------------------------------

export const pushTokenResponse = z.object({
  pushToken: z.object({
    platform: z.enum(PUSH_PLATFORMS),
    lastSeenAt: isoDate,
  }),
});

// --- Legal ------------------------------------------------------------------------------

const legalDoc = z.object({
  doc: z.enum(['terms', 'privacy']),
  version: z.string(),
  url: z.string(),
});

export const legalDocumentsResponse = z.object({
  documents: z.array(legalDoc),
});

export const legalStatusResponse = z.object({
  documents: z.array(
    legalDoc.extend({
      acceptedVersion: z.string().nullable(),
      acceptedAt: isoDate.nullable(),
      upToDate: z
        .boolean()
        .describe('false = show the modal before letting the user continue.'),
    }),
  ),
});

export const legalAcceptResponse = z.object({
  document: z.looseObject({
    doc: z.enum(['terms', 'privacy']),
    version: z.string(),
  }),
});

// --- Health -------------------------------------------------------------------------------

export const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  database: z.string(),
  uptime: z.number(),
  timestamp: isoDate,
});

// --- Partners and the launch handshake (B3) ------------------------------------

const hexColor = z.string().regex(/^#[0-9A-F]{6}$/);

const partnerFeatures = z.object({
  buddies: z.boolean(),
  plans: z.boolean(),
  familiarLocations: z.boolean(),
});

export const partnerSummary = z.object({
  code: z.string(),
  name: z.string(),
  type: z.enum(PARTNER_TYPES),
});

export const partner = z.looseObject({
  _id: objectId,
  code: z.string(),
  name: z.string(),
  type: z.enum(PARTNER_TYPES),
  status: z.enum(PARTNER_STATUSES),
  brand: z.looseObject({
    displayName: z.string(),
    logoUrl: z.string().optional(),
    colors: z.object({ primary: hexColor, onPrimary: hexColor }),
    supportUrl: z.string().optional(),
    supportEmail: z.string().optional(),
  }),
  features: partnerFeatures,
  defaultPlan: z.enum(USER_PLANS).optional(),
  alertRecipients: z.array(
    z.object({ email: z.string(), name: z.string().optional() }),
  ),
  createdAt: isoDate,
  updatedAt: isoDate,
});

export const partnerResponse = z.object({ partner });
export const partnersResponse = z.object({ partners: z.array(partner) });
export const partnerSummaryResponse = z.object({ partner: partnerSummary });

export const provisionResponse = z.object({
  devices: z.array(
    z.object({
      deviceId: objectId,
      imeis: z.array(z.string()),
      serial: z.string().nullable(),
      status: z
        .enum(['provisioned', 'reissued', 'claimed'])
        .describe(
          'provisioned: new. reissued: already provisioned and not yet ' +
            'claimed, so a fresh token replaces the old one. claimed: the ' +
            'phone already holds its ingest token; no token is returned.',
        ),
      provisioningToken: z
        .string()
        .optional()
        .describe('Shown ONCE; only its hash is stored. Single use.'),
    }),
  ),
});

const partnerKey = z.object({
  id: objectId,
  name: z.string(),
  prefix: z.string().describe('The first characters, to tell keys apart.'),
  createdAt: isoDate,
  lastUsedAt: isoDate.nullable(),
  revokedAt: isoDate.nullable(),
});

export const partnerKeyIssuedResponse = z.object({
  key: partnerKey,
  apiKey: z
    .string()
    .describe('Shown ONCE; only its hash is stored. Send as X-Api-Key.'),
});
export const partnerKeysResponse = z.object({ keys: z.array(partnerKey) });

export const clientConfigResponse = z.object({
  config: z.object({
    platform: z.enum(CLIENT_PLATFORMS),
    versions: z.object({
      minimum: z.string(),
      recommended: z.string(),
      update: z
        .enum(['required', 'recommended', 'none', 'unknown'])
        .describe(
          'Against X-Client-Version: "required" = block until updated; ' +
            '"unknown" = the header was not sent.',
        ),
    }),
    partner: partnerSummary.nullable(),
    brand: z.object({
      displayName: z.string(),
      logoUrl: z.string().nullable(),
      colors: z.object({ primary: hexColor, onPrimary: hexColor }),
      supportUrl: z.string().nullable(),
      supportEmail: z.string().nullable(),
    }),
    features: partnerFeatures.describe(
      'Optional features this build should show. Evidence is never optional.',
    ),
  }),
});

// --- Partner webhooks, partner device read, status cards (B5) ------------------

const webhook = z.object({
  id: objectId,
  url: z.string(),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  secretPrefix: z
    .string()
    .describe(
      'The first characters of the signing secret, to tell them apart.',
    ),
  createdAt: isoDate,
});

const webhookSecret = z
  .string()
  .describe(
    'The signing secret (whsec_...). Shown ONCE, here and on rotation; ' +
      'verify Tambo-Signature with it.',
  );

export const webhookCreatedResponse = z.object({
  webhook,
  secret: webhookSecret,
});
export const webhooksResponse = z.object({ webhooks: z.array(webhook) });

const webhookDelivery = z.object({
  id: objectId,
  eventId: z.string().describe('Also sent as Tambo-Event-Id; dedup on it.'),
  type: z.enum([...WEBHOOK_EVENTS, 'ping']),
  status: z
    .enum(['pending', 'delivered', 'failed'])
    .describe('failed: every retry was used up (8 attempts over ~45 h).'),
  attempts: z.number(),
  lastStatusCode: z.number().nullable(),
  lastError: z
    .string()
    .nullable()
    .describe(
      'http_<status>, timeout, address_blocked, https_required, or a ' +
        'network error code.',
    ),
  nextAttemptAt: isoDate.nullable(),
  deliveredAt: isoDate.nullable(),
  createdAt: isoDate,
});

export const webhookDeliveryResponse = z.object({ delivery: webhookDelivery });
export const webhookDeliveriesResponse = z.object({
  deliveries: z.array(webhookDelivery).describe('Newest first, at most 50.'),
});

export const partnerDevice = z.object({
  id: objectId,
  imeis: z
    .array(z.string())
    .nullable()
    .describe(
      'Only for phones this partner provisioned; null on a phone a person ' +
        "enrolled under the partner's code.",
    ),
  serial: z.string().nullable(),
  make: z.string(),
  deviceModel: z.string(),
  status: z.enum(['active', 'stolen']),
  provisioned: z.boolean(),
  claimedAt: isoDate.nullable(),
  linked: z.boolean().describe('Whether a person has linked the phone.'),
  linkedAt: isoDate.nullable(),
});

export const partnerDeviceResponse = z.object({
  device: partnerDevice,
  openEpisode: z
    .object({ id: objectId, openedAt: isoDate, openedBy: z.string() })
    .nullable(),
});

const cardBrand = z.object({
  displayName: z.string(),
  logoUrl: z.string().nullable(),
  colors: z.object({ primary: hexColor, onPrimary: hexColor }),
  supportUrl: z.string().nullable(),
  supportEmail: z.string().nullable(),
});

export const ownerStatusCardResponse = z.object({
  card: z.object({
    deviceId: objectId,
    deviceName: z.string(),
    state: z
      .enum(['protected', 'stolen', 'paused'])
      .describe(
        'stolen: an episode is open. paused: the ingest token was revoked, ' +
          'so the phone sends no evidence.',
      ),
    brand: cardBrand,
    lastSeenAt: isoDate
      .nullable()
      .describe("Server receipt time of the phone's latest evidence."),
    unlockAttempts: z.object({
      inWindow: z.number(),
      threshold: z.number(),
    }),
    episode: z
      .object({
        id: objectId,
        openedAt: isoDate,
        openedBy: z.enum(['owner', 'device', 'buddy']),
        snapshotBursts: z.number(),
        pendingCommands: z.number(),
        lastLocation: z
          .object({
            lat: z.number(),
            lng: z.number(),
            accuracyM: z.number().optional(),
            at: isoDate,
          })
          .nullable()
          .describe('Only from evidence around this episode.'),
      })
      .nullable(),
    refreshAfterSeconds: z.number(),
    generatedAt: isoDate,
  }),
});

export const deviceStatusCardResponse = z.object({
  card: z.object({
    deviceId: objectId,
    deviceName: z.string(),
    state: z
      .enum(['protected', 'unlinked'])
      .describe(
        'Never reveals an open episode: whoever holds the phone during one ' +
          'is presumably the thief. unlinked: nobody has signed in yet.',
      ),
    brand: cardBrand,
    refreshAfterSeconds: z.number(),
    generatedAt: isoDate,
  }),
});
