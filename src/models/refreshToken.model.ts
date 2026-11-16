import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';
import { CLIENT_PLATFORMS } from '../config/client';
import type { ClientPlatform } from '../config/client';

/**
 * One row per issued refresh token. Tokens are opaque random strings; only
 * their SHA-256 hash is stored, so a database leak does not hand out sessions.
 *
 * Rotation: refreshing revokes the presented token and issues a new one in the
 * same `family`. Presenting an already-revoked token means it leaked, so the
 * whole family is revoked (reuse detection).
 */
export interface IRefreshToken extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  tokenHash: string;
  family: string;
  expiresAt: Date;
  revokedAt?: Date;
  userAgent?: string;
  /** From X-Client-Platform / X-Client-Version; refresh updates them. */
  clientPlatform?: ClientPlatform;
  clientVersion?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    // TTL index: mongo removes rows once they expire, so the collection is self-pruning
    expiresAt: { type: Date, required: true, expires: 0 },
    revokedAt: { type: Date },
    userAgent: { type: String },
    clientPlatform: { type: String, enum: CLIENT_PLATFORMS },
    clientVersion: { type: String },
  },
  { timestamps: true },
);

export const RefreshToken = model<IRefreshToken>(
  'RefreshToken',
  refreshTokenSchema,
);
export default RefreshToken;
