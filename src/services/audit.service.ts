import type { Types } from 'mongoose';
import AuthEvent from '../models/authEvent.model';
import type { AuthEventType, IAuthEvent } from '../models/authEvent.model';
import { logger } from '../utils/logger';

/**
 * The auth-event audit trail. Recording is deliberately fire-and-forget and
 * exception-proof: an audit hiccup must never fail a login or a revocation.
 * The ledger is best-effort evidence, not a transactional invariant.
 */

const RETENTION_DAYS = 365;

export interface AuditContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export const record = (
  userId: string | Types.ObjectId,
  type: AuthEventType,
  context: AuditContext = {},
): void => {
  void AuthEvent.create({
    user: userId,
    type,
    at: new Date(),
    ...(context.ip ? { ip: context.ip } : {}),
    ...(context.userAgent ? { userAgent: context.userAgent } : {}),
    ...(context.meta ? { meta: context.meta } : {}),
    expiresAt: new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000),
  }).catch((error) => {
    logger.error({ err: error, type }, 'failed to record auth event');
  });
};

/** The owner's recent security activity, newest first. */
export const listForUser = (
  userId: string,
  limit = 50,
): Promise<IAuthEvent[]> =>
  AuthEvent.find({ user: userId }).sort({ at: -1 }).limit(limit).exec();
