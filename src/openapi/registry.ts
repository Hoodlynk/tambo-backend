import type { ZodType } from 'zod';
import {
  changeEmailSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  otpResendSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sessionIdSchema,
} from '../validation/auth.schema';
import {
  buddyIdSchema,
  buddySchema,
  inviteActionSchema,
} from '../validation/buddy.schema';
import {
  deviceIdSchema,
  deviceSchema,
  deviceUpdateSchema,
  episodeIdSchema,
  episodeListQuerySchema,
  markStolenSchema,
} from '../validation/device.schema';
import {
  ingestSchema,
  mediaParamsSchema,
} from '../validation/evidence.schema';
import {
  familiarLocationIdSchema,
  familiarLocationSchema,
  familiarLocationUpdateSchema,
} from '../validation/familiarLocation.schema';
import { legalAcceptSchema } from '../validation/legal.schema';
import * as r from './responses';

/**
 * The single catalogue the OpenAPI document is generated from. Request shapes
 * are the SAME zod objects `validate(...)` enforces at runtime, so the spec
 * cannot drift from the server's actual behaviour; response shapes live in
 * ./responses.ts. Adding an endpoint without registering it here is the thing
 * code review must catch - the generator counts routes to help (see
 * tests/openapi.test.ts).
 */

export interface EndpointResponse {
  status: number;
  description: string;
  schema?: ZodType;
  /** Overrides application/json (e.g. application/pdf). */
  contentType?: string;
}

export interface EndpointError {
  status: number;
  code: string;
  description?: string;
}

export interface Endpoint {
  method: 'get' | 'post' | 'patch' | 'delete';
  /** OpenAPI-style path, e.g. /api/v1/devices/{id}. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  /** Absent = public. */
  auth?: 'bearer' | 'device';
  request?: {
    body?: ZodType;
    /** Overrides application/json (e.g. application/octet-stream). */
    bodyContentType?: string;
    bodyDescription?: string;
    params?: ZodType;
    query?: ZodType;
    headers?: { name: string; description: string; required: boolean }[];
  };
  responses: EndpointResponse[];
  errors?: EndpointError[];
}

const validationError: EndpointError = {
  status: 400,
  code: 'validation_error',
  description: 'A field failed validation; see details[].',
};
const rateLimited: EndpointError = {
  status: 429,
  code: 'rate_limited',
  description: 'Budget exhausted; retry after retryAfter seconds.',
};
const unauthorized: EndpointError = {
  status: 401,
  code: 'unauthorized',
  description:
    'Invalid/expired access token (code "missing_token" when the header is absent).',
};
const deviceUnauthorized: EndpointError = {
  status: 401,
  code: 'invalid_device_token',
  description:
    'Revoked or unknown X-Device-Token (code "missing_device_token" when absent).',
};

const deviceTokenHeader = {
  name: 'X-Device-Token',
  description: 'The one-shot ingest token issued at device registration.',
  required: true,
};

const csrfHeader = {
  name: 'X-Tambo-Csrf',
  description:
    'CSRF guard for the cookie surface; any value (e.g. "1"). A cross-site ' +
    'page cannot set custom headers without a CORS preflight, which the ' +
    'origin allowlist rejects.',
  required: true,
};

export const endpoints: Endpoint[] = [
  // --- Health ----------------------------------------------------------------
  {
    method: 'get',
    path: '/api/health',
    tag: 'Health',
    summary: 'Liveness + readiness',
    responses: [
      { status: 200, description: 'Healthy.', schema: r.healthResponse },
      {
        status: 503,
        description: 'Database unusable; stop routing traffic here.',
        schema: r.healthResponse,
      },
    ],
  },

  // --- Auth: credential entry ---------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/auth/register',
    tag: 'Auth',
    summary: 'Start a signup (always answers with an OTP challenge)',
    description:
      'No session exists until the emailed 6-digit code is verified at ' +
      '/auth/otp/verify. The mailbox must be proven.',
    request: { body: registerSchema },
    responses: [
      {
        status: 201,
        description: 'Code emailed; verify it to get the first session.',
        schema: r.challengeResponse,
      },
    ],
    errors: [
      validationError,
      { status: 409, code: 'email_taken' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/login',
    tag: 'Auth',
    summary: 'Password login',
    description:
      'BRANCH ON THE BODY SHAPE: `tokens` present means a session was issued; ' +
      '`challenge` present means the mailbox was never proven - collect the ' +
      'emailed code and verify it to complete the login.',
    request: { body: loginSchema },
    responses: [
      {
        status: 200,
        description:
          'Either { user, tokens } (verified account) or { challenge } ' +
          '(unproven mailbox; complete via /auth/otp/verify).',
        schema: r.authResponse.or(r.challengeResponse),
      },
    ],
    errors: [
      validationError,
      {
        status: 401,
        code: 'invalid_credentials',
        description: 'Same code for wrong password AND unknown email, by design.',
      },
      { status: 401, code: 'no_password_credential' },
      rateLimited,
    ],
  },

  // --- Auth: the browser (PWA) surface ------------------------------------------
  // The refresh token lives in an httpOnly cookie scoped to /api/auth/web;
  // every route requires the X-Tambo-Csrf header (any value) and, from a
  // browser, an Origin on the CORS allowlist. Register/forgot/reset are shared
  // with the main auth surface.
  ...(['login', 'otp/verify', 'refresh', 'logout'] as const).map(
    (leaf): Endpoint => {
      const base: Record<typeof leaf, Omit<Endpoint, 'method' | 'path'>> = {
        login: {
          tag: 'Auth (web)',
          summary: 'PWA login: session cookie set, or an OTP challenge',
          description:
            'Same branching as /auth/login. On success the refresh token is ' +
            'set as an httpOnly cookie and the body carries only ' +
            '{ user, tokens: { accessToken, expiresIn } }.',
          request: { body: loginSchema, headers: [csrfHeader] },
          responses: [
            {
              status: 200,
              description:
                'Either { user, tokens } (cookie set) or { challenge }.',
              schema: r.webAuthResponse.or(r.challengeResponse),
            },
          ],
          errors: [
            validationError,
            { status: 401, code: 'invalid_credentials' },
            { status: 403, code: 'csrf_rejected' },
            rateLimited,
          ],
        },
        'otp/verify': {
          tag: 'Auth (web)',
          summary: 'Complete a challenge; the session cookie is set',
          request: { body: otpVerifySchema, headers: [csrfHeader] },
          responses: [
            { status: 200, description: 'Verified; cookie set.', schema: r.webAuthResponse },
          ],
          errors: [
            validationError,
            { status: 401, code: 'invalid_otp' },
            { status: 401, code: 'otp_attempts_exceeded' },
            { status: 401, code: 'invalid_challenge' },
            { status: 403, code: 'csrf_rejected' },
            rateLimited,
          ],
        },
        refresh: {
          tag: 'Auth (web)',
          summary: 'Rotate the session using the cookie (no body)',
          request: { headers: [csrfHeader] },
          responses: [
            { status: 200, description: 'Rotated; new cookie set.', schema: r.webAuthResponse },
          ],
          errors: [
            { status: 401, code: 'missing_refresh_cookie' },
            { status: 401, code: 'invalid_refresh_token' },
            { status: 401, code: 'refresh_token_reused' },
            { status: 403, code: 'csrf_rejected' },
            rateLimited,
          ],
        },
        logout: {
          tag: 'Auth (web)',
          summary: 'Revoke the cookie session and clear the cookie (idempotent)',
          request: { headers: [csrfHeader] },
          responses: [{ status: 204, description: 'Cookie cleared.' }],
          errors: [{ status: 403, code: 'csrf_rejected' }],
        },
      };
      return { method: 'post', path: `/api/auth/web/${leaf}`, ...base[leaf] };
    },
  ),

  // --- Auth: OTP completion ---------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/auth/otp/verify',
    tag: 'Auth',
    summary: 'Complete any pending challenge with the emailed code',
    description: 'Every purpose ends in a fresh session (token pair).',
    request: { body: otpVerifySchema },
    responses: [
      { status: 200, description: 'Verified.', schema: r.authResponse },
    ],
    errors: [
      validationError,
      { status: 401, code: 'invalid_otp', description: 'Wrong code, tries remain.' },
      { status: 401, code: 'otp_attempts_exceeded', description: 'Budget burned; restart the flow.' },
      { status: 401, code: 'invalid_challenge', description: 'Expired/consumed/unknown; restart the flow.' },
      { status: 409, code: 'email_taken', description: 'email_change only: address claimed while the code was in flight.' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/otp/resend',
    tag: 'Auth',
    summary: 'Re-send the code for a live challenge (rotated, cooldown-limited)',
    request: { body: otpResendSchema },
    responses: [{ status: 204, description: 'A fresh code was emailed.' }],
    errors: [
      validationError,
      { status: 401, code: 'invalid_challenge' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/verify-email',
    tag: 'Auth',
    summary: 'Signed-in legacy account asks for a verification code',
    description:
      'Only pre-OTP accounts can be signed in with an unproven mailbox. Opens ' +
      'a signup-purpose challenge; verifying it heals emailVerifiedAt.',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'Code emailed.', schema: r.challengeResponse },
    ],
    errors: [
      unauthorized,
      { status: 400, code: 'no_email' },
      { status: 409, code: 'email_already_verified' },
      rateLimited,
    ],
  },

  // --- Auth: session lifecycle ----------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/auth/refresh',
    tag: 'Auth',
    summary: 'Rotate the refresh token for a new pair',
    description:
      'Single-use: the presented token is revoked and a successor issued. A ' +
      'token presented twice burns its whole family (leak response).',
    request: { body: refreshSchema },
    responses: [
      { status: 200, description: 'Rotated.', schema: r.authResponse },
    ],
    errors: [
      validationError,
      { status: 401, code: 'invalid_refresh_token' },
      {
        status: 401,
        code: 'refresh_token_reused',
        description:
          'This token was already rotated - treated as a leak; the whole ' +
          'session family is revoked. Sign in again.',
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/logout',
    tag: 'Auth',
    summary: 'Revoke the session the refresh token belongs to (idempotent)',
    request: { body: logoutSchema },
    responses: [{ status: 204, description: 'Revoked (or already gone).' }],
    errors: [validationError],
  },
  {
    method: 'post',
    path: '/api/v1/auth/logout-all',
    tag: 'Auth',
    summary: 'Revoke every session for this account',
    auth: 'bearer',
    responses: [{ status: 204, description: 'All sessions revoked.' }],
    errors: [unauthorized],
  },
  {
    method: 'get',
    path: '/api/v1/auth/me',
    tag: 'Auth',
    summary: 'The signed-in account',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.meResponse }],
    errors: [unauthorized],
  },
  {
    method: 'get',
    path: '/api/v1/auth/sessions',
    tag: 'Auth',
    summary: 'Active sessions (devices) for this account',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.sessionsResponse }],
    errors: [unauthorized],
  },
  {
    method: 'delete',
    path: '/api/v1/auth/sessions/{id}',
    tag: 'Auth',
    summary: 'Revoke one session (sign that device out)',
    auth: 'bearer',
    request: { params: sessionIdSchema },
    responses: [{ status: 204, description: 'Revoked.' }],
    errors: [unauthorized, { status: 404, code: 'session_not_found' }],
  },

  // --- Auth: password lifecycle -----------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/auth/change-password',
    tag: 'Auth',
    summary: 'Start a password change (completed by OTP)',
    description: 'Nothing changes until the emailed code is verified.',
    auth: 'bearer',
    request: { body: changePasswordSchema },
    responses: [
      { status: 200, description: 'Code emailed.', schema: r.challengeResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 401, code: 'invalid_credentials', description: 'Current password wrong.' },
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/change-email',
    tag: 'Auth',
    summary: 'Start an email change (code goes to the NEW address)',
    auth: 'bearer',
    request: { body: changeEmailSchema },
    responses: [
      { status: 200, description: 'Code emailed to the new address.', schema: r.challengeResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 401, code: 'invalid_credentials' },
      { status: 400, code: 'email_unchanged' },
      { status: 409, code: 'email_taken' },
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/forgot-password',
    tag: 'Auth',
    summary: 'Request a password-reset link',
    description:
      'Always 204 - whether or not the account exists - so the endpoint ' +
      'cannot be used to probe for registered emails.',
    request: { body: forgotPasswordSchema },
    responses: [{ status: 204, description: 'If the account exists, a link was emailed.' }],
    errors: [validationError, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/auth/reset-password',
    tag: 'Auth',
    summary: 'Set a new password with an emailed reset token',
    description: 'Single-use token. Success revokes every session and reset link.',
    request: { body: resetPasswordSchema },
    responses: [
      { status: 200, description: 'Password set; fresh session issued.', schema: r.authResponse },
    ],
    errors: [
      validationError,
      { status: 401, code: 'invalid_reset_token', description: 'Used/expired/unknown.' },
      rateLimited,
    ],
  },

  // --- Devices ----------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/devices',
    tag: 'Devices',
    summary: 'Enrol a device (returns its one-shot ingest token)',
    description:
      'Gated on current T&C + privacy acceptance. The ingestToken appears in ' +
      'this response and never again - only its hash is stored.',
    auth: 'bearer',
    request: { body: deviceSchema },
    responses: [
      { status: 201, description: 'Enrolled.', schema: r.deviceWithTokenResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      {
        status: 403,
        code: 'legal_acceptance_required',
        description: 'Accept the current terms + privacy first (see /api/v1/legal).',
      },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/devices',
    tag: 'Devices',
    summary: 'List enrolled devices',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.devicesResponse }],
    errors: [unauthorized],
  },
  {
    method: 'get',
    path: '/api/v1/devices/{id}',
    tag: 'Devices',
    summary: 'One device',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.deviceResponse }],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/devices/{id}/activity',
    tag: 'Devices',
    summary: 'Failed-unlock report ("has anyone been trying my PIN?")',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.activityResponse }],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'patch',
    path: '/api/v1/devices/{id}',
    tag: 'Devices',
    summary: 'Update device details',
    auth: 'bearer',
    request: { params: deviceIdSchema, body: deviceUpdateSchema },
    responses: [{ status: 200, description: 'Updated.', schema: r.deviceResponse }],
    errors: [unauthorized, validationError, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'delete',
    path: '/api/v1/devices/{id}',
    tag: 'Devices',
    summary: 'Remove a device',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 204, description: 'Removed.' }],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/token',
    tag: 'Devices',
    summary: 'Rotate the ingest token (old one stops working)',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [
      { status: 200, description: 'New token; shown once.', schema: r.ingestTokenResponse },
    ],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'delete',
    path: '/api/v1/devices/{id}/token',
    tag: 'Devices',
    summary: 'Revoke the ingest token',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 204, description: 'Revoked.' }],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/mark-stolen',
    tag: 'Devices',
    summary: 'Owner marks the device stolen (opens/converges on an episode)',
    auth: 'bearer',
    request: { params: deviceIdSchema, body: markStolenSchema },
    responses: [
      { status: 201, description: 'This call opened the episode.', schema: r.episodeResponse },
      { status: 200, description: 'Converged on the already-open episode.', schema: r.episodeResponse },
    ],
    errors: [unauthorized, validationError, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/mark-recovered',
    tag: 'Devices',
    summary: 'Owner marks the device back in hand (resolves the episode)',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 200, description: 'Resolved.', schema: r.episodeResponse }],
    errors: [
      unauthorized,
      { status: 404, code: 'device_not_found' },
      { status: 404, code: 'episode_not_found' },
    ],
  },

  // --- Episodes & the evidence pack ------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/episodes',
    tag: 'Episodes',
    summary: 'List theft episodes (optionally per device)',
    auth: 'bearer',
    request: { query: episodeListQuerySchema },
    responses: [{ status: 200, description: 'Newest first.', schema: r.episodesResponse }],
    errors: [unauthorized, validationError],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}',
    tag: 'Episodes',
    summary: 'One episode',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.episodeResponse }],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}/trail',
    tag: 'Episodes',
    summary: 'The location trail: ordered fixes, static vs moving, familiar context',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.trailResponse }],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}/pack',
    tag: 'Episodes',
    summary: 'The evidence pack (JSON, Ed25519-signed manifest)',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.packResponse }],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}/pack.pdf',
    tag: 'Episodes',
    summary: 'The evidence pack as a PDF (photos embedded)',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [
      { status: 200, description: 'The PDF bytes.', contentType: 'application/pdf' },
    ],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'post',
    path: '/api/v1/episodes/{id}/send-pack',
    tag: 'Episodes',
    summary: 'Email the pack (PDF attached) to the owner and accepted buddies',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [{ status: 200, description: 'Dispatched.', schema: r.packSendResponse }],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }, rateLimited],
  },

  // --- Evidence ingest (device-token auth, not user auth) ----------------------------------------
  {
    method: 'post',
    path: '/api/v1/evidence',
    tag: 'Evidence',
    summary: 'Ingest a batch of evidence envelopes (idempotent per envelope id)',
    description:
      'Authenticates as a DEVICE via X-Device-Token. 200 even with ' +
      'per-envelope rejections: read the ACK list; retry only failures. An ' +
      'ingest response carrying episodeId/episodeOpened is the cue to start ' +
      'the location-trail fan-out.',
    auth: 'device',
    request: {
      body: ingestSchema,
      headers: [deviceTokenHeader],
    },
    responses: [{ status: 200, description: 'Per-envelope ACKs.', schema: r.ingestResponse }],
    errors: [deviceUnauthorized, validationError, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/evidence/{envelopeId}/media',
    tag: 'Evidence',
    summary: 'Attach photo bytes to a PHOTO envelope (hash-verified, idempotent)',
    auth: 'device',
    request: {
      params: mediaParamsSchema,
      bodyContentType: 'application/octet-stream',
      bodyDescription: 'The raw media bytes, exactly as hashed.',
      headers: [
        deviceTokenHeader,
        {
          name: 'X-Content-Sha256',
          description: 'Hex SHA-256 of the request body; verified server-side.',
          required: true,
        },
      ],
    },
    responses: [
      { status: 201, description: 'Stored.', schema: r.mediaAckResponse },
      { status: 200, description: 'Identical content already stored.', schema: r.mediaAckResponse },
    ],
    errors: [
      deviceUnauthorized,
      { status: 400, code: 'missing_content_hash' },
      { status: 400, code: 'empty_media' },
      { status: 400, code: 'hash_mismatch', description: 'Body bytes do not hash to X-Content-Sha256.' },
      { status: 400, code: 'not_photo_envelope' },
      { status: 404, code: 'envelope_not_found' },
      { status: 409, code: 'media_conflict', description: 'Envelope already has DIFFERENT media attached.' },
      { status: 413, code: 'payload_too_large' },
      rateLimited,
    ],
  },

  // --- Buddies -------------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/buddies',
    tag: 'Buddies',
    summary: 'Nominate a buddy by email',
    description:
      'Always yields "pending" - the response never reveals whether the ' +
      'address belongs to a Tambo account. The buddy accepts IN-APP; if the ' +
      'email is not registered yet, the link auto-binds when they sign up.',
    auth: 'bearer',
    request: { body: buddySchema },
    responses: [{ status: 201, description: 'Invited.', schema: r.buddyCreatedResponse }],
    errors: [
      unauthorized,
      validationError,
      { status: 400, code: 'buddy_is_self' },
      { status: 400, code: 'buddy_limit_reached' },
      { status: 409, code: 'buddy_exists' },
      rateLimited,
    ],
  },
  {
    method: 'get',
    path: '/api/v1/buddies',
    tag: 'Buddies',
    summary: 'List nominated buddies (owner view)',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.buddiesResponse }],
    errors: [unauthorized],
  },
  {
    method: 'delete',
    path: '/api/v1/buddies/{id}',
    tag: 'Buddies',
    summary: 'Remove a buddy (they stop receiving alerts)',
    auth: 'bearer',
    request: { params: buddyIdSchema },
    responses: [{ status: 204, description: 'Removed.' }],
    errors: [unauthorized, { status: 404, code: 'buddy_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/buddy-invites',
    tag: 'Buddies',
    summary: 'Invitations addressed to me (buddy view)',
    auth: 'bearer',
    responses: [{ status: 200, description: 'Pending invitations.', schema: r.invitesResponse }],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/buddy-invites/{id}/{action}',
    tag: 'Buddies',
    summary: 'Accept or decline an invitation (action: accept | decline)',
    auth: 'bearer',
    request: { params: inviteActionSchema },
    responses: [{ status: 200, description: 'Recorded.', schema: r.inviteResponseResponse }],
    errors: [unauthorized, validationError, { status: 404, code: 'invite_not_found' }],
  },

  // --- Familiar locations -----------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/familiar-locations',
    tag: 'Familiar locations',
    summary: 'List registered familiar places',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.familiarLocationsResponse }],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/familiar-locations',
    tag: 'Familiar locations',
    summary: 'Register a familiar place (max 10; interpretation only)',
    description:
      'Familiarity NEVER relaxes thresholds, episodes, or alerts - it only ' +
      'annotates trails and reports ("left familiar location home at ...").',
    auth: 'bearer',
    request: { body: familiarLocationSchema },
    responses: [{ status: 201, description: 'Created.', schema: r.familiarLocationResponse }],
    errors: [
      unauthorized,
      validationError,
      { status: 409, code: 'familiar_location_exists' },
      { status: 409, code: 'familiar_location_limit' },
    ],
  },
  {
    method: 'patch',
    path: '/api/v1/familiar-locations/{id}',
    tag: 'Familiar locations',
    summary: 'Update a familiar place',
    auth: 'bearer',
    request: { params: familiarLocationIdSchema, body: familiarLocationUpdateSchema },
    responses: [{ status: 200, description: 'Updated.', schema: r.familiarLocationResponse }],
    errors: [
      unauthorized,
      validationError,
      { status: 404, code: 'familiar_location_not_found' },
      { status: 409, code: 'familiar_location_exists' },
    ],
  },
  {
    method: 'delete',
    path: '/api/v1/familiar-locations/{id}',
    tag: 'Familiar locations',
    summary: 'Delete a familiar place',
    auth: 'bearer',
    request: { params: familiarLocationIdSchema },
    responses: [{ status: 204, description: 'Deleted.' }],
    errors: [unauthorized, { status: 404, code: 'familiar_location_not_found' }],
  },

  // --- Legal -------------------------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/legal',
    tag: 'Legal',
    summary: 'Current T&C + privacy versions and where the content lives',
    description: 'Public: the app shows the modal before a session exists.',
    responses: [{ status: 200, description: 'OK.', schema: r.legalDocumentsResponse }],
  },
  {
    method: 'get',
    path: '/api/v1/legal/status',
    tag: 'Legal',
    summary: 'What this user accepted vs current (upToDate: false ⇒ re-prompt)',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.legalStatusResponse }],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/legal/accept',
    tag: 'Legal',
    summary: 'Record acceptance of one document (send scrolledToEnd: true)',
    auth: 'bearer',
    request: { body: legalAcceptSchema },
    responses: [{ status: 200, description: 'Recorded.', schema: r.legalAcceptResponse }],
    errors: [
      unauthorized,
      validationError,
      { status: 409, code: 'stale_legal_version', description: 'The document changed while it was on screen; reload it.' },
    ],
  },
];
