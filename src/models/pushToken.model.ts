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
 *
 * `device` is set when the install registered through its device token
 * (POST /evidence/push-token, B2): that is the token remote commands wake,
 * and the one a theft alert about THAT device skips - the thief holding it
 * must not see "your phone may be stolen" on its lock screen.
 *
 * `alerts` separates the two jobs one install can do. Sign-out and
 * credential rotation turn a device-bound row's alerts off instead of
 * deleting it, so the account stops talking to a possibly stolen phone
 * while remote commands can still wake it. Only a signed-in register
 * turns alerts back on.
 */
export interface IPushToken extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  device?: Types.ObjectId;
  /** Whether the account's alerts reach this install (wake-ups always do). */
  alerts: boolean;
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
    device: { type: Schema.Types.ObjectId, ref: 'Device' },
    alerts: { type: Boolean, default: true },
    token: { type: String, required: true, unique: true },
    platform: { type: String, enum: PUSH_PLATFORMS, required: true },
    userAgent: { type: String },
    lastSeenAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

pushTokenSchema.index({ device: 1 }, { sparse: true });

export const PushToken = model<IPushToken>('PushToken', pushTokenSchema);
export default PushToken;
