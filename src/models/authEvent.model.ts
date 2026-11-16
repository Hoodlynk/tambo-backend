import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const AUTH_EVENT_TYPES = [
  'login_succeeded',
  'login_failed',
  'login_challenged', // correct password, unproven mailbox -> OTP
  'otp_verified',
  'otp_failed',
  'password_changed',
  'email_changed',
  'password_reset_requested',
  'password_reset',
  'sessions_revoked_all',
  'session_revoked',
  'account_locked',
  'plan_changed',
  // admin acts on partner credentials, recorded against the admin's account
  'partner_key_issued',
  'partner_key_revoked',
] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/**
 * Append-only security ledger: who did what to this account's authentication,
 * from where. Powers the owner's "recent security activity" view and gives an
 * operator a forensic timeline after an incident. Never updated, never read
 * on hot paths; writes are fire-and-forget so auditing can never break auth.
 *
 * TTL keeps it from growing forever - a year covers any dispute window the
 * product currently has.
 */
export interface IAuthEvent extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: AuthEventType;
  at: Date;
  ip?: string;
  userAgent?: string;
  /** Small, non-secret context (e.g. { sessionId }). Never tokens or codes. */
  meta?: Record<string, unknown>;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const authEventSchema = new Schema<IAuthEvent>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: AUTH_EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    ip: { type: String },
    userAgent: { type: String },
    meta: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// the owner's security view: this user's events, newest first
authEventSchema.index({ user: 1, at: -1 });

export const AuthEvent = model<IAuthEvent>('AuthEvent', authEventSchema);
export default AuthEvent;
