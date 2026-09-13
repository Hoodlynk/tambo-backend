import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_PLANS = ['free', 'pro', 'family'] as const;
export type UserPlan = (typeof USER_PLANS)[number];

export interface IUser extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  name: string;
  /** Present for email/password accounts. Phone-OTP accounts may have none. */
  email?: string;
  /** Reserved for the phone-OTP flow. Stored normalized to E.164. */
  phone?: string;
  /** Absent for credential-less accounts such as phone-OTP-only users. */
  passwordHash?: string;
  role: UserRole;
  /**
   * The subscription tier. What it UNLOCKS is decided in one place -
   * services/entitlements.ts - never by reading this field directly in a
   * feature service. `planExpiresAt` absent = never expires (free forever;
   * a billing webhook sets both). An expired paid plan reads as free.
   */
  plan: UserPlan;
  planExpiresAt?: Date;
  emailVerifiedAt?: Date;
  phoneVerifiedAt?: Date;
  /**
   * Watermark for "sign out everywhere": any refresh token CREATED at or
   * before this instant is dead, even if a concurrent rotation wrote it after
   * the bulk revoke ran. Checked at use time in session.service.refresh.
   */
  sessionsInvalidatedAt?: Date;
  /** Consecutive failed password logins; reset on success and on lock. */
  failedLoginAttempts: number;
  /** While in the future, password login answers 423 account_locked. */
  lockedUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      // sparse so phone-only accounts do not all collide on a null email
      index: { unique: true, sparse: true },
    },
    phone: {
      type: String,
      trim: true,
      index: { unique: true, sparse: true },
    },
    // never selected by default; the auth service opts in explicitly
    passwordHash: { type: String, select: false },
    role: { type: String, enum: USER_ROLES, default: 'user' },
    plan: { type: String, enum: USER_PLANS, default: 'free' },
    planExpiresAt: { type: Date },
    emailVerifiedAt: { type: Date },
    phoneVerifiedAt: { type: Date },
    sessionsInvalidatedAt: { type: Date },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.passwordHash;
        return ret;
      },
    },
  },
);

export const User = model<IUser>('User', userSchema);
export default User;
