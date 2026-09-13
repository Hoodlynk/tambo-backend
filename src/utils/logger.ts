import pino from 'pino';
import config from '../config/config';

/**
 * The one logger. JSON lines to stdout (the deploy platform ships them);
 * silent under test. Redaction is defence in depth - the house rule is that
 * secrets (tokens, codes, password material) are never passed to a log call
 * in the first place (docs/security.md).
 */
export const logger = pino({
  level: config.log.level,
  redact: {
    // NOTE: no 'code' path here - the errorHandler logs the ERROR code
    // (invalid_credentials, refresh_token_reused, ...) on purpose: that field
    // is what makes credential-stuffing and replay visible in logs. OTP codes
    // are never passed to a log call in the first place (the house rule).
    paths: [
      'authorization',
      'refreshToken',
      'accessToken',
      'otp',
      'password',
      '*.authorization',
      '*.refreshToken',
      '*.accessToken',
      '*.otp',
      '*.password',
    ],
    censor: '[redacted]',
  },
  base: null, // no pid/hostname noise; the platform adds instance labels
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** A child logger carrying the request id, for handler-adjacent code. */
export type Logger = typeof logger;
