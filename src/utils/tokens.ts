import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import config from '../config/config';
import { AppError } from './appError';
import type { UserRole } from '../models/user.model';

export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
}

export const signAccessToken = (payload: AccessTokenPayload): string =>
  jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl as NonNullable<SignOptions['expiresIn']>,
  });

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret);
    if (
      typeof decoded === 'string' ||
      typeof decoded.sub !== 'string' ||
      (decoded.role !== 'user' && decoded.role !== 'admin')
    ) {
      // a missing/garbage role claim is as malformed as a missing sub - the
      // type says UserRole, so nothing downstream may receive undefined
      throw AppError.unauthorized('Malformed access token.', 'invalid_token');
    }
    return { sub: decoded.sub, role: decoded.role as UserRole };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      // distinct code so the mobile client knows to hit /auth/refresh rather than log out
      throw AppError.unauthorized('Access token expired.', 'token_expired');
    }
    throw AppError.unauthorized('Invalid access token.', 'invalid_token');
  }
};

/** The one sha256-hex idiom in the codebase; every hashing call site shares it. */
export const sha256Hex = (value: string | Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

/**
 * Opaque server-issued token (refresh tokens, password-reset tokens, and later
 * OTP secrets): random bytes with the database as the authority, stored only
 * as a hash so a database leak yields nothing usable.
 */
export const generateOpaqueToken = (): string =>
  crypto.randomBytes(48).toString('hex');

export const hashOpaqueToken = (token: string): string => sha256Hex(token);
