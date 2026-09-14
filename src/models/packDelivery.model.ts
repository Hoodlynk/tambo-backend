import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const DELIVERY_KINDS = ['first_alert', 'full_pack'] as const;
export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export const DELIVERY_CHANNELS = ['email', 'push'] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

/**
 * One notification dispatched about one episode to one recipient. Two jobs:
 *
 * - first_alert is once-per-recipient-per-episode, enforced by a partial
 *   unique index - the owner marking stolen AND the device threshold firing
 *   must not double-alert anyone.
 * - full_pack rows are an audit trail (packs may legitimately be re-sent as
 *   more evidence arrives), and the earliest first_alert row is the
 *   "first-alert time" the pack's incident summary reports.
 *
 * No TTL, deliberately: this is the delivery AUDIT ledger ("who was told
 * what, when" - the kind of question an insurer dispute asks years later),
 * rows are tiny, and volume is bounded by the packSend rate limit.
 *
 * `recipient` is an email address on the email channel and a user id on the
 * push channel; `channel` is part of the first-alert uniqueness, so each
 * human gets at most one first alert PER CHANNEL per episode and the two
 * channels never suppress each other.
 */
export interface IPackDelivery extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  episode: Types.ObjectId;
  kind: DeliveryKind;
  recipient: string;
  channel: DeliveryChannel;
  sentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const packDeliverySchema = new Schema<IPackDelivery>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    episode: {
      type: Schema.Types.ObjectId,
      ref: 'TheftEpisode',
      required: true,
    },
    kind: { type: String, enum: DELIVERY_KINDS, required: true },
    recipient: { type: String, required: true },
    // default keeps pre-push rows reading correctly
    channel: { type: String, enum: DELIVERY_CHANNELS, default: 'email' },
    sentAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

packDeliverySchema.index({ episode: 1, kind: 1, sentAt: 1 });

// exactly one first-alert per recipient per channel per episode, enforced by
// the database. Deploy note: the pre-push index {episode, recipient, kind}
// remains compatible (email recipients and push user ids never collide) but
// should be dropped once this one exists - mongoose creates indexes, it never
// removes old ones.
packDeliverySchema.index(
  { episode: 1, recipient: 1, kind: 1, channel: 1 },
  { unique: true, partialFilterExpression: { kind: 'first_alert' } },
);

export const PackDelivery = model<IPackDelivery>(
  'PackDelivery',
  packDeliverySchema,
);
export default PackDelivery;
