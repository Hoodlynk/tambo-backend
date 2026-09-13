import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const PUSH_PLATFORMS = ['android', 'web', 'ios'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/**
 * One FCM registration token = one installed app on one device. `token` is
 * globally unique and re-registering it under another account REASSIGNS it -
 * a phone that changes hands must not keep receiving the previous owner's
 * theft alerts. No TTL: dead tokens are pruned when FCM reports them dead at
 * send time (error-driven, no cron), and a per-user cap with LRU eviction
 * (`lastSeenAt`) bounds fan-out regardless.
 */
export interface IPushToken extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  token: string;
  platform: PushPlatform;
  userAgent?: string;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pushTokenSchema = new Schema<IPushToken>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    userAgent: { type: String },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

export const PushToken = model<IPushToken>('PushToken', pushTokenSchema);
export default PushToken;
