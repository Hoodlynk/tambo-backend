import { z } from 'zod';
import { AUTH_EVENT_TYPES } from '../models/authEvent.model';
import { OTP_PURPOSES } from '../models/otpChallenge.model';
import { PUSH_PLATFORMS } from '../models/pushToken.model';
import { USER_PLANS } from '../models/user.model';

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
  user: objectId,
  name: z.string(),
  imeis: z.array(z.string()),
  make: z.string(),
  deviceModel: z.string(),
  colour: z.string().optional(),
  purchaseInfo: z.string().optional(),
  failedUnlockThreshold: z.number(),
  status: z.enum(['active', 'stolen']),
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
  user: objectId,
  device: objectId,
  status: z.enum(['open', 'resolved']),
  openedBy: z.enum(['owner', 'device']),
  openedAt: isoDate,
  resolvedAt: isoDate.optional(),
  resolution: z.string().optional(),
  note: z.string().optional(),
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
        source: z.enum(['UNLOCK_FAILED', 'TRAIL_POINT']),
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
  photos: z.array(z.looseObject({})),
  actionChecklist: z.array(z.string()),
  integrity: z.looseObject({
    algorithm: z.literal('Ed25519'),
    publicKeyBase64: z.string(),
    signatureBase64: z.string(),
  }),
});

export const packResponse = z.object({ pack });

export const packSendResponse = z.object({
  recipients: z.array(z.string()).describe('Email addresses the pack went to.'),
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
    entitlements: z.object({
      maxDevices: z.number(),
      historyDays: z
        .number()
        .nullable()
        .describe('null = full history (bounded only by evidence retention).'),
      trailCadenceSeconds: z.number(),
      pushAlerts: z.boolean(),
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
