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
  commandCreateSchema,
  commandParamsSchema,
} from '../validation/command.schema';
import {
  alertActionTokenSchema,
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
  snapshotMediaParamsSchema,
} from '../validation/evidence.schema';
import {
  familiarLocationIdSchema,
  familiarLocationSchema,
  familiarLocationUpdateSchema,
} from '../validation/familiarLocation.schema';
import { legalAcceptSchema } from '../validation/legal.schema';
import {
  clientConfigQuerySchema,
  partnerCreateSchema,
  partnerIdSchema,
  partnerKeyCreateSchema,
  partnerKeyParamsSchema,
  partnerUpdateSchema,
} from '../validation/partner.schema';
import {
  claimSchema,
  linkSchema,
  provisionSchema,
} from '../validation/provisioning.schema';
import { planSetSchema, planUserIdSchema } from '../validation/plan.schema';
import {
  webhookCreateSchema,
  webhookIdSchema,
} from '../validation/webhook.schema';
import {
  pushTokenRegisterSchema,
  pushTokenUnregisterSchema,
} from '../validation/pushToken.schema';
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
  auth?: 'bearer' | 'device' | 'partnerKey';
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
  code: 'invalid_token',
  description:
    'Also: "missing_token" when the Authorization header is absent, and ' +
    '"token_expired" when the token lapsed - on token_expired the client ' +
    'refreshes instead of signing out.',
};
const deviceUnauthorized: EndpointError = {
  status: 401,
  code: 'invalid_device_token',
  description:
    'Revoked or unknown X-Device-Token (code "missing_device_token" when absent).',
};

const partnerKeyUnauthorized: EndpointError = {
  status: 401,
  code: 'invalid_api_key',
  description:
    'Unknown or revoked X-Api-Key, or the partner is suspended (code ' +
    '"missing_api_key" when absent).',
};
const adminOnly: EndpointError = {
  status: 403,
  code: 'forbidden',
  description: 'Not an admin.',
};
const partnerNotFound: EndpointError = {
  status: 404,
  code: 'partner_not_found',
};

const clientVersionHeader = {
  name: 'X-Client-Version',
  description:
    'The app build as X.Y.Z. Sent on every request by current clients ' +
    '(with X-Client-Platform); here it decides versions.update.',
  required: false,
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
      '/auth/otp/verify. The mailbox must be proven. A white-label build ' +
      'passes `partnerCode`; the account joins that partner and receives ' +
      "the partner's default plan, if it has one.",
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
      {
        status: 400,
        code: 'unknown_partner',
        description: 'partnerCode is unknown or the partner is suspended.',
      },
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
        description:
          'Same code for wrong password AND unknown email, by design.',
      },
      {
        status: 403,
        code: 'email_unverified',
        description:
          'Legacy answer for builds that send no X-Client-Platform header: ' +
          'the unproven-mailbox case as an error, with the login challenge ' +
          'in `challenge`. Clients that send the header get the 200 shape.',
      },
      {
        status: 423,
        code: 'account_locked',
        description:
          'Too many consecutive failed logins; retry after retryAfter ' +
          'seconds, or reset the password (which clears the lock).',
      },
      rateLimited,
    ],
  },

  // --- Auth: the browser (PWA) surface ------------------------------------------
  // The refresh token lives in an httpOnly cookie scoped to /api/auth/web;
  // every route requires the X-Tambo-Csrf header (any value) and, from a
  // browser, an Origin that is the API's own or on the CORS allowlist.
  // Register/forgot/reset are shared with the main auth surface.
  {
    method: 'post',
    path: '/api/auth/web/login',
    tag: 'Auth (web)',
    summary: 'PWA login: session cookie set, or an OTP challenge',
    description:
      'Same branching as /auth/login. On success the refresh token is set ' +
      'as an httpOnly cookie and the body carries only ' +
      '{ user, tokens: { accessToken, expiresIn } }.',
    request: { body: loginSchema, headers: [csrfHeader] },
    responses: [
      {
        status: 200,
        description: 'Either { user, tokens } (cookie set) or { challenge }.',
        schema: r.webAuthResponse.or(r.challengeResponse),
      },
    ],
    errors: [
      validationError,
      { status: 401, code: 'invalid_credentials' },
      { status: 403, code: 'csrf_rejected' },
      {
        status: 423,
        code: 'account_locked',
        description:
          'Same lockout as the mobile login; retry after retryAfter ' +
          'seconds or reset the password.',
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/auth/web/otp/verify',
    tag: 'Auth (web)',
    summary: 'Complete a challenge; the session cookie is set',
    request: { body: otpVerifySchema, headers: [csrfHeader] },
    responses: [
      {
        status: 200,
        description: 'Verified; cookie set.',
        schema: r.webAuthResponse,
      },
    ],
    errors: [
      validationError,
      { status: 401, code: 'invalid_otp' },
      { status: 401, code: 'otp_attempts_exceeded' },
      { status: 401, code: 'invalid_challenge' },
      { status: 403, code: 'csrf_rejected' },
      {
        status: 409,
        code: 'email_taken',
        description:
          'email_change challenges only: the address was claimed while the code was in flight.',
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/auth/web/refresh',
    tag: 'Auth (web)',
    summary: 'Rotate the session using the cookie (no body)',
    request: { headers: [csrfHeader] },
    responses: [
      {
        status: 200,
        description: 'Rotated; new cookie set.',
        schema: r.webAuthResponse,
      },
    ],
    errors: [
      { status: 401, code: 'missing_refresh_cookie' },
      { status: 401, code: 'invalid_refresh_token' },
      { status: 401, code: 'refresh_token_reused' },
      { status: 403, code: 'csrf_rejected' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/auth/web/reset-password',
    tag: 'Auth (web)',
    summary: 'Complete a password reset; the session arrives as a cookie',
    description:
      'Same token semantics as /auth/reset-password, but the fresh session ' +
      'is set as the httpOnly cookie (never in the body) so the PWA recovery ' +
      'flow stays inside the cookie transport.',
    request: { body: resetPasswordSchema, headers: [csrfHeader] },
    responses: [
      {
        status: 200,
        description: 'Password set; cookie session issued.',
        schema: r.webAuthResponse,
      },
    ],
    errors: [
      { status: 401, code: 'invalid_reset_token' },
      { status: 403, code: 'csrf_rejected' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/auth/web/logout',
    tag: 'Auth (web)',
    summary: 'Revoke the cookie session and clear the cookie (idempotent)',
    request: { headers: [csrfHeader] },
    responses: [{ status: 204, description: 'Cookie cleared.' }],
    errors: [{ status: 403, code: 'csrf_rejected' }],
  },

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
      {
        status: 401,
        code: 'invalid_otp',
        description: 'Wrong code, tries remain.',
      },
      {
        status: 401,
        code: 'otp_attempts_exceeded',
        description: 'Budget burned; restart the flow.',
      },
      {
        status: 401,
        code: 'invalid_challenge',
        description: 'Expired/consumed/unknown; restart the flow.',
      },
      {
        status: 409,
        code: 'email_taken',
        description:
          'email_change only: address claimed while the code was in flight.',
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/auth/otp/resend',
    tag: 'Auth',
    summary:
      'Re-send the code for a live challenge (rotated, cooldown-limited)',
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
      {
        status: 200,
        description: 'Code emailed.',
        schema: r.challengeResponse,
      },
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
    responses: [
      { status: 200, description: 'OK.', schema: r.sessionsResponse },
    ],
    errors: [unauthorized],
  },
  {
    method: 'get',
    path: '/api/v1/auth/security-events',
    tag: 'Auth',
    summary: "The account's recent security activity (audit trail)",
    description:
      'Newest first, capped at 50. Types cover logins (success/failure/OTP ' +
      'challenge), OTP outcomes, password/email changes, resets, session ' +
      'revocations, and lockouts.',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'OK.', schema: r.securityEventsResponse },
    ],
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
      {
        status: 200,
        description: 'Code emailed.',
        schema: r.challengeResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      {
        status: 401,
        code: 'invalid_credentials',
        description: 'Current password wrong.',
      },
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
      {
        status: 200,
        description: 'Code emailed to the new address.',
        schema: r.challengeResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 401, code: 'invalid_credentials' },
      { status: 400, code: 'no_password_credential' },
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
    responses: [
      {
        status: 204,
        description: 'If the account exists, a link was emailed.',
      },
    ],
    errors: [validationError, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/auth/reset-password',
    tag: 'Auth',
    summary: 'Set a new password with an emailed reset token',
    description:
      'Single-use token. Success revokes every session and reset link.',
    request: { body: resetPasswordSchema },
    responses: [
      {
        status: 200,
        description: 'Password set; fresh session issued.',
        schema: r.authResponse,
      },
    ],
    errors: [
      validationError,
      {
        status: 401,
        code: 'invalid_reset_token',
        description: 'Used/expired/unknown.',
      },
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
      'this response and never again - only its hash is stored. The device ' +
      "joins `partnerCode`'s fleet, or the owner's partner when omitted. " +
      'With an `installId` the call is idempotent per (owner, install): the ' +
      'app may enrol on every sign-in, and a known install gets a fresh ' +
      'token for its existing device (the old token stops working).',
    auth: 'bearer',
    request: { body: deviceSchema },
    responses: [
      {
        status: 201,
        description: 'Enrolled.',
        schema: r.deviceWithTokenResponse,
      },
      {
        status: 200,
        description: 'Known installId: token re-issued for the same device.',
        schema: r.deviceWithTokenResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      {
        status: 400,
        code: 'unknown_partner',
        description: 'partnerCode is unknown or the partner is suspended.',
      },
      {
        status: 403,
        code: 'legal_acceptance_required',
        description:
          'Accept the current terms + privacy first (see /api/v1/legal). ' +
          'Builds that send no X-Client-Platform are exempt while ' +
          'LEGACY_CLIENT_LEGAL_EXEMPT is on.',
      },
      {
        status: 409,
        code: 'device_limit',
        description:
          "The plan's device allowance is used up (free/pro: 1, family: 5). " +
          'Already-enrolled devices keep working regardless.',
      },
    ],
  },
  {
    method: 'post',
    path: '/api/v1/devices/claim',
    tag: 'Devices',
    summary: 'A provisioned phone claims its ingest token (no account)',
    description:
      'Device-first enrolment (docs/provisioning-api.md). The phone trades ' +
      'the provisioning token its partner gave it for an ingest token and ' +
      'starts protecting before anyone signs in. `installId` is a random id ' +
      'the app keeps per install: the same install may retry a claim whose ' +
      'response was lost (200, the ingest token rotates) until the phone is ' +
      'linked; any other install gets 409. When the server enforces Play ' +
      'Integrity, `integrityToken` is required and its request hash must be ' +
      'sha256("tambo-claim:<provisioningToken>:<installId>") in hex.',
    request: { body: claimSchema },
    responses: [
      {
        status: 201,
        description: 'Claimed. The ingest token is shown once.',
        schema: r.deviceWithTokenResponse,
      },
      {
        status: 200,
        description: 'The same install retried; a fresh ingest token.',
        schema: r.deviceWithTokenResponse,
      },
    ],
    errors: [
      validationError,
      {
        status: 400,
        code: 'integrity_required',
        description: 'The server enforces Play Integrity and none was sent.',
      },
      {
        status: 401,
        code: 'invalid_provisioning_token',
        description: 'Unknown token, or the partner is suspended.',
      },
      {
        status: 403,
        code: 'integrity_failed',
        description: 'The Play Integrity verdict was refused.',
      },
      {
        status: 409,
        code: 'device_already_claimed',
        description:
          'Another install claimed this phone, or it is already linked.',
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/link',
    tag: 'Devices',
    summary: 'Link a provisioned phone to the signed-in account',
    description:
      'Needs BOTH the Bearer session (who) and the X-Device-Token of the ' +
      'phone being linked (proof of holding it). The account inherits the ' +
      "phone's history. Idempotent for the same account. Gated on current " +
      "T&C + privacy acceptance, and counted against the plan's device " +
      'allowance, like enrolment.',
    auth: 'bearer',
    request: {
      params: deviceIdSchema,
      body: linkSchema,
      headers: [
        {
          ...deviceTokenHeader,
          description: 'The ingest token the phone received when it claimed.',
        },
      ],
    },
    responses: [
      { status: 200, description: 'Linked.', schema: r.deviceResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      {
        status: 401,
        code: 'invalid_device_token',
        description:
          'Revoked or unknown X-Device-Token ("missing_device_token" when absent).',
      },
      {
        status: 403,
        code: 'legal_acceptance_required',
        description:
          'Accept the current terms + privacy first (see /api/v1/legal).',
      },
      {
        status: 404,
        code: 'device_not_found',
        description: 'Unknown id, or the device token is for another phone.',
      },
      {
        status: 409,
        code: 'device_already_linked',
        description: 'The phone belongs to another account.',
      },
      {
        status: 409,
        code: 'episode_open',
        description:
          'The phone has an open theft episode; its partner resolves it first.',
      },
      {
        status: 409,
        code: 'device_limit',
        description: "The plan's device allowance is used up.",
      },
      rateLimited,
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
    responses: [
      { status: 200, description: 'OK.', schema: r.activityResponse },
    ],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/devices/{id}/status-card',
    tag: 'Devices',
    summary: "The owner's status card for one phone (widget data)",
    description:
      'Everything a widget or Zero-screen card shows about this phone, ' +
      'including an open episode and, from evidence around it, where the ' +
      'phone was last seen. Sent with Cache-Control: no-store.',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [
      {
        status: 200,
        description: 'OK.',
        schema: r.ownerStatusCardResponse,
      },
    ],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'patch',
    path: '/api/v1/devices/{id}',
    tag: 'Devices',
    summary: 'Update device details',
    auth: 'bearer',
    request: { params: deviceIdSchema, body: deviceUpdateSchema },
    responses: [
      { status: 200, description: 'Updated.', schema: r.deviceResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 404, code: 'device_not_found' },
    ],
  },
  {
    method: 'delete',
    path: '/api/v1/devices/{id}',
    tag: 'Devices',
    summary: 'Remove a device',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [{ status: 204, description: 'Removed.' }],
    errors: [
      unauthorized,
      { status: 404, code: 'device_not_found' },
      {
        status: 409,
        code: 'episode_open',
        description:
          'The device has an open theft episode; resolve it (mark-recovered) first.',
      },
    ],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/token',
    tag: 'Devices',
    summary: 'Rotate the ingest token (old one stops working)',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [
      {
        status: 200,
        description: 'New token; shown once.',
        schema: r.ingestTokenResponse,
      },
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
      {
        status: 201,
        description: 'This call opened the episode.',
        schema: r.episodeResponse,
      },
      {
        status: 200,
        description: 'Converged on the already-open episode.',
        schema: r.episodeResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 404, code: 'device_not_found' },
    ],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/mark-recovered',
    tag: 'Devices',
    summary: 'Owner marks the device back in hand (resolves the episode)',
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [
      { status: 200, description: 'Resolved.', schema: r.episodeResponse },
    ],
    errors: [
      unauthorized,
      { status: 404, code: 'device_not_found' },
      { status: 404, code: 'episode_not_found' },
    ],
  },

  // --- Remote commands (B2) ---------------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/devices/{id}/commands',
    tag: 'Commands',
    summary: 'Ask the stolen phone to snapshot, locate, or ring',
    description:
      'Only while the device has an open episode. The phone is woken by a ' +
      'silent push when it has a device-scoped push token, and otherwise ' +
      'picks the command up on its next poll or ingest reply. Repeating a ' +
      'type that is still outstanding converges on it (200) instead of ' +
      'queueing another. cameras applies to snapshot only, durationSeconds ' +
      'to ring only.',
    auth: 'bearer',
    request: { params: deviceIdSchema, body: commandCreateSchema },
    responses: [
      {
        status: 201,
        description: 'Issued.',
        schema: r.commandResponse,
      },
      {
        status: 200,
        description: 'Converged on the outstanding command of this type.',
        schema: r.commandResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 404, code: 'device_not_found' },
      {
        status: 409,
        code: 'episode_not_open',
        description: 'Commands need an open episode (mark the device stolen).',
      },
      {
        status: 409,
        code: 'device_token_revoked',
        description: 'The device has no ingest token, so it cannot poll.',
      },
      rateLimited,
    ],
  },
  {
    method: 'get',
    path: '/api/v1/devices/{id}/commands',
    tag: 'Commands',
    summary: "A device's recent commands and where each got to (newest first)",
    auth: 'bearer',
    request: { params: deviceIdSchema },
    responses: [
      { status: 200, description: 'OK.', schema: r.commandsResponse },
    ],
    errors: [unauthorized, { status: 404, code: 'device_not_found' }],
  },
  {
    method: 'post',
    path: '/api/v1/devices/{id}/commands/{commandId}/cancel',
    tag: 'Commands',
    summary: 'Cancel an outstanding command (idempotent)',
    description:
      'A command that already finished, or was already cancelled, is ' +
      'returned unchanged.',
    auth: 'bearer',
    request: { params: commandParamsSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.commandResponse }],
    errors: [
      unauthorized,
      { status: 404, code: 'device_not_found' },
      { status: 404, code: 'command_not_found' },
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
    responses: [
      { status: 200, description: 'Newest first.', schema: r.episodesResponse },
    ],
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
    summary:
      'The location trail: ordered fixes, static vs moving, familiar context',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.trailResponse }],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}/snapshots',
    tag: 'Episodes',
    summary:
      'Camera snapshot bursts: frames grouped per capture, each pinned to a place',
    description:
      'PHOTO envelopes grouped by burstId in server-receipt order. Owner ' +
      'only: buddies receive photos in the PDF pack, never a URL. Each frame ' +
      'carries mediaPath for the bytes; hasMedia is false until they arrive.',
    auth: 'bearer',
    request: { params: episodeIdSchema },
    responses: [
      { status: 200, description: 'OK.', schema: r.snapshotsResponse },
    ],
    errors: [unauthorized, { status: 404, code: 'episode_not_found' }],
  },
  {
    method: 'get',
    path: '/api/v1/episodes/{id}/snapshots/{envelopeId}',
    tag: 'Episodes',
    summary: 'The bytes of one snapshot frame',
    description:
      'Streams the stored media with its content type; X-Content-Sha256 ' +
      'carries the hash the integrity manifest lists. Scoped to the episode: ' +
      'an envelope id alone never opens a photo.',
    auth: 'bearer',
    request: { params: snapshotMediaParamsSchema },
    responses: [
      {
        status: 200,
        description: 'The image bytes.',
        contentType: 'image/jpeg',
      },
    ],
    errors: [
      unauthorized,
      { status: 404, code: 'episode_not_found' },
      {
        status: 404,
        code: 'snapshot_not_found',
        description: 'No PHOTO envelope with that id in this episode.',
      },
      {
        status: 404,
        code: 'media_not_available',
        description: 'The envelope exists but its bytes have not arrived yet.',
      },
    ],
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
      {
        status: 200,
        description: 'The PDF bytes.',
        contentType: 'application/pdf',
      },
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
    responses: [
      { status: 200, description: 'Dispatched.', schema: r.packSendResponse },
    ],
    errors: [
      unauthorized,
      { status: 404, code: 'episode_not_found' },
      rateLimited,
    ],
  },

  // --- Evidence ingest (device-token auth, not user auth) ----------------------------------------
  {
    method: 'post',
    path: '/api/v1/evidence',
    tag: 'Evidence',
    summary:
      'Ingest a batch of evidence envelopes (idempotent per envelope id)',
    description:
      'Authenticates as a DEVICE via X-Device-Token. 200 even with ' +
      'per-envelope rejections: read the ACK list; retry only failures. An ' +
      'ingest response carrying episodeId/episodeOpened is the cue to start ' +
      'the location-trail fan-out and the camera bursts; trailCadenceSeconds ' +
      'and snapshotPolicy are the advisory cadence for each. pendingCommands ' +
      'lists outstanding remote commands (same shape as GET /evidence/commands).',
    auth: 'device',
    request: {
      body: ingestSchema,
      headers: [deviceTokenHeader],
    },
    responses: [
      {
        status: 200,
        description: 'Per-envelope ACKs.',
        schema: r.ingestResponse,
      },
    ],
    errors: [deviceUnauthorized, validationError, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/evidence/{envelopeId}/media',
    tag: 'Evidence',
    summary:
      'Attach photo bytes to a PHOTO envelope (hash-verified, idempotent)',
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
      {
        status: 200,
        description: 'Identical content already stored.',
        schema: r.mediaAckResponse,
      },
    ],
    errors: [
      deviceUnauthorized,
      { status: 400, code: 'missing_content_hash' },
      { status: 400, code: 'empty_media' },
      {
        status: 400,
        code: 'hash_mismatch',
        description: 'Body bytes do not hash to X-Content-Sha256.',
      },
      { status: 400, code: 'not_photo_envelope' },
      { status: 404, code: 'envelope_not_found' },
      {
        status: 409,
        code: 'media_conflict',
        description: 'Envelope already has DIFFERENT media attached.',
      },
      { status: 413, code: 'payload_too_large' },
      rateLimited,
    ],
  },

  {
    method: 'post',
    path: '/api/v1/evidence/heartbeat',
    tag: 'Evidence',
    summary: 'The phone checks in when it has nothing to upload',
    description:
      'Authenticates as a DEVICE via X-Device-Token; no body. Every upload ' +
      'already counts as contact, so call this only on the idle timer ' +
      '(about every 15 minutes). A phone that stops checking in triggers ' +
      'the "went quiet" email to its owner.',
    auth: 'device',
    request: { headers: [deviceTokenHeader] },
    responses: [
      { status: 200, description: 'OK.', schema: r.heartbeatResponse },
    ],
    errors: [deviceUnauthorized, rateLimited],
  },
  {
    method: 'get',
    path: '/api/v1/evidence/commands',
    tag: 'Commands',
    summary: 'The device polls for outstanding remote commands',
    description:
      'Authenticates as a DEVICE via X-Device-Token. Call on a ' +
      'device_command wake-up push, and on the trail timer while an episode ' +
      'is open. Commands are re-sent until answered, cancelled, or expired; ' +
      'dedup on id and ignore any past expiresAt.',
    auth: 'device',
    request: { headers: [deviceTokenHeader] },
    responses: [
      { status: 200, description: 'OK.', schema: r.deviceCommandsResponse },
    ],
    errors: [deviceUnauthorized, rateLimited],
  },
  {
    method: 'get',
    path: '/api/v1/evidence/status',
    tag: 'Evidence',
    summary: "The phone's own status card, for its widget (device token)",
    description:
      'Discreet by design: never reveals an open episode, the failed-unlock ' +
      'count or a location, since whoever holds the phone during an episode ' +
      'is presumably the thief. Refresh every refreshAfterSeconds.',
    auth: 'device',
    request: { headers: [deviceTokenHeader] },
    responses: [
      {
        status: 200,
        description: 'OK.',
        schema: r.deviceStatusCardResponse,
      },
    ],
    errors: [deviceUnauthorized, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/evidence/push-token',
    tag: 'Push',
    summary: 'The protected phone registers its push token (device token)',
    description:
      'Binds the FCM token to this enrolled device so remote commands can ' +
      'wake it, and so theft alerts about this device skip it. Call on ' +
      'every app start and on FCM token rotation; it keeps working after ' +
      "the owner's sessions are revoked. The token still receives the " +
      "owner's other alerts.",
    auth: 'device',
    request: {
      body: pushTokenRegisterSchema,
      headers: [deviceTokenHeader],
    },
    responses: [
      { status: 200, description: 'Registered.', schema: r.pushTokenResponse },
    ],
    errors: [
      deviceUnauthorized,
      validationError,
      {
        status: 409,
        code: 'device_not_linked',
        description:
          'A provisioned phone nobody has linked yet has no account to ' +
          'register under; link it first.',
      },
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
    responses: [
      { status: 201, description: 'Invited.', schema: r.buddyCreatedResponse },
    ],
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
    path: '/api/v1/protecting',
    tag: 'Buddies',
    summary: 'The people I am an accepted buddy for, with their devices',
    description:
      'Identity and status only: no IMEIs, no check-in times. Feeds the ' +
      '"report stolen for a friend" screen.',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'OK.', schema: r.protectedResponse },
    ],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/protecting/devices/{id}/report-stolen',
    tag: 'Buddies',
    summary: "An accepted buddy reports the owner's phone stolen",
    description:
      'For the owner whose only phone is the stolen one. Needs an ACTIVE ' +
      'buddy link to the device owner; any other device answers 404 like an ' +
      'unknown id. Alerts go out exactly as for an owner report.',
    auth: 'bearer',
    request: { params: deviceIdSchema, body: markStolenSchema },
    responses: [
      {
        status: 201,
        description: 'This call opened the episode.',
        schema: r.buddyReportResponse,
      },
      {
        status: 200,
        description: 'Converged on the already-open episode.',
        schema: r.buddyReportResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      rateLimited,
      { status: 404, code: 'device_not_found' },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/alert-actions/{token}',
    tag: 'Devices',
    summary: 'Confirmation page for the one-tap link in a "went quiet" email',
    description:
      'PUBLIC and opened in a browser, never by the app: the emailed token ' +
      'is the credential. Read-only, because mail scanners pre-fetch links. ' +
      'Always 200 with an HTML page, including for a dead link.',
    request: { params: alertActionTokenSchema },
    responses: [
      {
        status: 200,
        description: 'An HTML page: the confirm form, or "link expired".',
        contentType: 'text/html',
      },
    ],
    errors: [validationError, rateLimited],
  },
  {
    method: 'post',
    path: '/api/v1/alert-actions/{token}',
    tag: 'Devices',
    summary: 'Spend the one-tap link: mark the device stolen',
    description:
      'PUBLIC; submitted by the form on the confirmation page. Single-use: ' +
      'opens (or converges on) the theft episode and alerts the buddies. ' +
      'Always 200 with an HTML page, including for a dead link.',
    request: { params: alertActionTokenSchema },
    responses: [
      {
        status: 200,
        description: 'An HTML page: marked stolen, already stolen, or expired.',
        contentType: 'text/html',
      },
    ],
    errors: [validationError, rateLimited],
  },
  {
    method: 'get',
    path: '/api/v1/buddy-invites',
    tag: 'Buddies',
    summary: 'Invitations addressed to me (buddy view)',
    auth: 'bearer',
    responses: [
      {
        status: 200,
        description: 'Pending invitations.',
        schema: r.invitesResponse,
      },
    ],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/buddy-invites/{id}/{action}',
    tag: 'Buddies',
    summary: 'Accept or decline an invitation (action: accept | decline)',
    auth: 'bearer',
    request: { params: inviteActionSchema },
    responses: [
      {
        status: 200,
        description: 'Recorded.',
        schema: r.inviteResponseResponse,
      },
    ],
    errors: [
      unauthorized,
      validationError,
      { status: 404, code: 'invite_not_found' },
    ],
  },

  // --- Familiar locations -----------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/familiar-locations',
    tag: 'Familiar locations',
    summary: 'List registered familiar places',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'OK.', schema: r.familiarLocationsResponse },
    ],
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
    responses: [
      {
        status: 201,
        description: 'Created.',
        schema: r.familiarLocationResponse,
      },
    ],
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
    request: {
      params: familiarLocationIdSchema,
      body: familiarLocationUpdateSchema,
    },
    responses: [
      {
        status: 200,
        description: 'Updated.',
        schema: r.familiarLocationResponse,
      },
    ],
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
    errors: [
      unauthorized,
      { status: 404, code: 'familiar_location_not_found' },
    ],
  },

  // --- Plan ------------------------------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/plan',
    tag: 'Plan',
    summary: "The account's plan and what it unlocks",
    description:
      'Backs the Settings "Subscription" row. `effectivePlan` is what is in ' +
      'force now - a lapsed paid plan reads as free. Entitlements shape reads ' +
      'and enrolment only; evidence upload is NEVER plan-gated.',
    auth: 'bearer',
    responses: [{ status: 200, description: 'OK.', schema: r.planResponse }],
    errors: [unauthorized],
  },
  {
    method: 'patch',
    path: '/api/v1/plan/{userId}',
    tag: 'Plan',
    summary: "Set a user's plan (admin only; billing webhook takes over later)",
    auth: 'bearer',
    request: { params: planUserIdSchema, body: planSetSchema },
    responses: [
      { status: 200, description: 'Updated.', schema: r.planResponse },
    ],
    errors: [
      unauthorized,
      { status: 403, code: 'forbidden', description: 'Not an admin.' },
      validationError,
      { status: 404, code: 'user_not_found' },
    ],
  },

  // --- Push tokens ---------------------------------------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/push-tokens',
    tag: 'Push',
    summary: 'Register this installation for push notifications (upsert)',
    description:
      'Call on every app start with the current FCM registration token. ' +
      'Re-registering is free; registering a token that belonged to another ' +
      'account reassigns it. Dead tokens are pruned automatically when FCM ' +
      'reports them.',
    auth: 'bearer',
    request: { body: pushTokenRegisterSchema },
    responses: [
      { status: 200, description: 'Registered.', schema: r.pushTokenResponse },
    ],
    errors: [unauthorized, validationError, rateLimited],
  },
  {
    method: 'delete',
    path: '/api/v1/push-tokens',
    tag: 'Push',
    summary: 'Unregister a token (e.g. on sign-out); idempotent',
    auth: 'bearer',
    request: { body: pushTokenUnregisterSchema },
    responses: [{ status: 204, description: 'Gone (or never existed).' }],
    errors: [unauthorized, validationError],
  },

  // --- Legal -------------------------------------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/legal',
    tag: 'Legal',
    summary: 'Current T&C + privacy versions and where the content lives',
    description: 'Public: the app shows the modal before a session exists.',
    responses: [
      { status: 200, description: 'OK.', schema: r.legalDocumentsResponse },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/legal/status',
    tag: 'Legal',
    summary: 'What this user accepted vs current (upToDate: false ⇒ re-prompt)',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'OK.', schema: r.legalStatusResponse },
    ],
    errors: [unauthorized],
  },
  {
    method: 'post',
    path: '/api/v1/legal/accept',
    tag: 'Legal',
    summary: 'Record acceptance of one document (send scrolledToEnd: true)',
    auth: 'bearer',
    request: { body: legalAcceptSchema },
    responses: [
      { status: 200, description: 'Recorded.', schema: r.legalAcceptResponse },
    ],
    errors: [
      unauthorized,
      validationError,
      {
        status: 409,
        code: 'stale_legal_version',
        description: 'The document changed while it was on screen; reload it.',
      },
    ],
  },
  // --- Client launch handshake (B3) ---------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/client/config',
    tag: 'Client',
    summary: 'Launch handshake: update policy, brand theme, feature flags',
    description:
      'Call at app start, before sign-in. A white-label build passes its ' +
      'partner code; an unbranded build omits it and gets Tambo. Cacheable ' +
      'for 5 minutes. A suspended partner keeps its brand for phones in the ' +
      'field.',
    request: { query: clientConfigQuerySchema, headers: [clientVersionHeader] },
    responses: [
      { status: 200, description: 'OK.', schema: r.clientConfigResponse },
    ],
    errors: [
      validationError,
      {
        status: 404,
        code: 'unknown_partner',
        description: 'No partner has that code: a misbuilt branded app.',
      },
      rateLimited,
    ],
  },

  // --- Partner systems (X-Api-Key) ------------------------------------------------------------
  {
    method: 'get',
    path: '/api/v1/partner/me',
    tag: 'Partners',
    summary: 'Which partner this API key belongs to (integration check)',
    auth: 'partnerKey',
    responses: [
      { status: 200, description: 'OK.', schema: r.partnerSummaryResponse },
    ],
    errors: [partnerKeyUnauthorized, rateLimited],
  },

  {
    method: 'post',
    path: '/api/v1/partner/devices',
    tag: 'Partners',
    summary: 'Provision handsets in bulk; one single-use token per phone',
    description:
      'Device-first enrolment (docs/provisioning-api.md). Up to 500 handsets ' +
      'per call; one result per row, in order. Re-provisioning a handset ' +
      'this partner already has (any shared IMEI) never creates a second ' +
      'device: before the claim it reissues the token, after it it reports ' +
      '`claimed`.',
    auth: 'partnerKey',
    request: { body: provisionSchema },
    responses: [
      { status: 200, description: 'OK.', schema: r.provisionResponse },
    ],
    errors: [partnerKeyUnauthorized, validationError, rateLimited],
  },
  {
    method: 'get',
    path: '/api/v1/partner/devices/{id}',
    tag: 'Partners',
    summary: "One of the partner's phones: claimed, linked, open episode",
    description:
      'Any phone in the fleet, provisioned or enrolled under the partner ' +
      'code. The same device shape webhooks carry: no owner identity, no ' +
      'location, IMEIs only for phones the partner provisioned.',
    auth: 'partnerKey',
    request: { params: deviceIdSchema },
    responses: [
      { status: 200, description: 'OK.', schema: r.partnerDeviceResponse },
    ],
    errors: [
      partnerKeyUnauthorized,
      {
        status: 404,
        code: 'device_not_found',
        description: "Unknown id, or not this partner's device.",
      },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/partner/devices/{id}/mark-recovered',
    tag: 'Partners',
    summary: "Resolve an episode on one of the partner's unlinked phones",
    description:
      'For a phone nobody has linked yet: a false alarm in the shop, or the ' +
      "handset is back in stock. A linked phone is its owner's to resolve.",
    auth: 'partnerKey',
    request: { params: deviceIdSchema },
    responses: [
      { status: 200, description: 'Resolved.', schema: r.episodeResponse },
    ],
    errors: [
      partnerKeyUnauthorized,
      {
        status: 404,
        code: 'device_not_found',
        description: "Unknown id, or not this partner's device.",
      },
      {
        status: 404,
        code: 'episode_not_found',
        description: 'No open episode.',
      },
      {
        status: 409,
        code: 'device_linked',
        description: 'The phone has an owner; only they can resolve it.',
      },
      rateLimited,
    ],
  },

  // --- Partner webhooks (X-Api-Key) -----------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/partner/webhooks',
    tag: 'Webhooks',
    summary: 'Register an endpoint; the signing secret is shown once',
    description:
      'https only. `events` defaults to every event that exists today; ' +
      'events added later are opt-in. At most 5 endpoints per partner.',
    auth: 'partnerKey',
    request: { body: webhookCreateSchema },
    responses: [
      {
        status: 201,
        description: 'Created.',
        schema: r.webhookCreatedResponse,
      },
    ],
    errors: [
      partnerKeyUnauthorized,
      validationError,
      {
        status: 409,
        code: 'webhook_limit',
        description: 'The partner already has 5 endpoints.',
      },
      rateLimited,
    ],
  },
  {
    method: 'get',
    path: '/api/v1/partner/webhooks',
    tag: 'Webhooks',
    summary: "The partner's endpoints, oldest first",
    auth: 'partnerKey',
    responses: [
      { status: 200, description: 'OK.', schema: r.webhooksResponse },
    ],
    errors: [partnerKeyUnauthorized, rateLimited],
  },
  {
    method: 'delete',
    path: '/api/v1/partner/webhooks/{id}',
    tag: 'Webhooks',
    summary: 'Remove an endpoint, with its queue and delivery log',
    auth: 'partnerKey',
    request: { params: webhookIdSchema },
    responses: [{ status: 204, description: 'Removed.' }],
    errors: [
      partnerKeyUnauthorized,
      { status: 404, code: 'webhook_not_found' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/partner/webhooks/{id}/rotate-secret',
    tag: 'Webhooks',
    summary: 'Replace the signing secret; the old one stops at once',
    description: 'Retries still queued are signed with the new secret.',
    auth: 'partnerKey',
    request: { params: webhookIdSchema },
    responses: [
      {
        status: 200,
        description: 'Rotated.',
        schema: r.webhookCreatedResponse,
      },
    ],
    errors: [
      partnerKeyUnauthorized,
      { status: 404, code: 'webhook_not_found' },
      rateLimited,
    ],
  },
  {
    method: 'post',
    path: '/api/v1/partner/webhooks/{id}/ping',
    tag: 'Webhooks',
    summary: 'Send a signed ping to one endpoint (integration check)',
    description:
      'Queued and sent at once, whatever the endpoint subscribes to. The ' +
      'delivery log shows the outcome.',
    auth: 'partnerKey',
    request: { params: webhookIdSchema },
    responses: [
      {
        status: 202,
        description: 'Queued.',
        schema: r.webhookDeliveryResponse,
      },
    ],
    errors: [
      partnerKeyUnauthorized,
      { status: 404, code: 'webhook_not_found' },
      rateLimited,
    ],
  },
  {
    method: 'get',
    path: '/api/v1/partner/webhooks/{id}/deliveries',
    tag: 'Webhooks',
    summary: "One endpoint's delivery log, newest first",
    description: 'The last 50 deliveries; the log keeps 30 days.',
    auth: 'partnerKey',
    request: { params: webhookIdSchema },
    responses: [
      {
        status: 200,
        description: 'OK.',
        schema: r.webhookDeliveriesResponse,
      },
    ],
    errors: [
      partnerKeyUnauthorized,
      { status: 404, code: 'webhook_not_found' },
      rateLimited,
    ],
  },

  // --- Admin: partner catalogue -----------------------------------------------------------------
  {
    method: 'post',
    path: '/api/v1/admin/partners',
    tag: 'Partners',
    summary: 'Create a white-label partner (admin only)',
    auth: 'bearer',
    request: { body: partnerCreateSchema },
    responses: [
      { status: 201, description: 'Created.', schema: r.partnerResponse },
    ],
    errors: [
      unauthorized,
      adminOnly,
      validationError,
      { status: 409, code: 'partner_code_taken' },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/admin/partners',
    tag: 'Partners',
    summary: 'List partners, newest first (admin only)',
    auth: 'bearer',
    responses: [
      { status: 200, description: 'OK.', schema: r.partnersResponse },
    ],
    errors: [unauthorized, adminOnly],
  },
  {
    method: 'get',
    path: '/api/v1/admin/partners/{id}',
    tag: 'Partners',
    summary: 'One partner (admin only)',
    auth: 'bearer',
    request: { params: partnerIdSchema },
    responses: [{ status: 200, description: 'OK.', schema: r.partnerResponse }],
    errors: [unauthorized, adminOnly, partnerNotFound],
  },
  {
    method: 'patch',
    path: '/api/v1/admin/partners/{id}',
    tag: 'Partners',
    summary: 'Update a partner; the code is immutable (admin only)',
    description:
      '`features` merges flag by flag; `brand` and `alertRecipients` replace ' +
      'whole. `defaultPlan: null` stops granting a plan to new signups ' +
      '(existing accounts keep theirs). `status: "suspended"` stops new ' +
      'signups and API keys; branding keeps serving.',
    auth: 'bearer',
    request: { params: partnerIdSchema, body: partnerUpdateSchema },
    responses: [
      { status: 200, description: 'Updated.', schema: r.partnerResponse },
    ],
    errors: [unauthorized, adminOnly, validationError, partnerNotFound],
  },
  {
    method: 'post',
    path: '/api/v1/admin/partners/{id}/keys',
    tag: 'Partners',
    summary: 'Issue a partner API key, shown once (admin only)',
    auth: 'bearer',
    request: { params: partnerIdSchema, body: partnerKeyCreateSchema },
    responses: [
      {
        status: 201,
        description: 'Issued.',
        schema: r.partnerKeyIssuedResponse,
      },
    ],
    errors: [unauthorized, adminOnly, validationError, partnerNotFound],
  },
  {
    method: 'get',
    path: '/api/v1/admin/partners/{id}/keys',
    tag: 'Partners',
    summary: "A partner's API keys, revoked ones included (admin only)",
    auth: 'bearer',
    request: { params: partnerIdSchema },
    responses: [
      { status: 200, description: 'OK.', schema: r.partnerKeysResponse },
    ],
    errors: [unauthorized, adminOnly, partnerNotFound],
  },
  {
    method: 'delete',
    path: '/api/v1/admin/partners/{id}/keys/{keyId}',
    tag: 'Partners',
    summary: 'Revoke a partner API key; idempotent (admin only)',
    auth: 'bearer',
    request: { params: partnerKeyParamsSchema },
    responses: [{ status: 204, description: 'Revoked.' }],
    errors: [
      unauthorized,
      adminOnly,
      { status: 404, code: 'partner_key_not_found' },
    ],
  },
];
