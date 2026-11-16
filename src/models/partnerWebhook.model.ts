import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

/** What a partner endpoint may subscribe to. */
export const WEBHOOK_EVENTS = [
  'episode.opened',
  'episode.resolved',
  'snapshot.received',
  'device.claimed',
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Sent only on request, to every endpoint regardless of its subscription. */
export type WebhookDeliveryType = WebhookEvent | 'ping';

/**
 * An endpoint a partner system registered to hear about its fleet (B5).
 *
 * The signing secret is stored as-is, unlike API keys: HMAC needs the secret
 * itself on every send, so a hash would be useless. It is never selected by
 * default and never serialized; docs/roadmap.md tracks encrypting it at rest.
 */
export interface IPartnerWebhook extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  partner: Types.ObjectId;
  url: string;
  events: WebhookEvent[];
  secret: string;
  /** Enough of the secret to tell which one an endpoint has; never enough to sign. */
  secretPrefix: string;
  createdAt: Date;
  updatedAt: Date;
}

const partnerWebhookSchema = new Schema<IPartnerWebhook>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: 'Partner',
      required: true,
      index: true,
    },
    url: { type: String, required: true },
    events: { type: [String], enum: WEBHOOK_EVENTS, required: true },
    secret: { type: String, required: true, select: false },
    secretPrefix: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.secret;
        return ret;
      },
    },
  },
);

export const PartnerWebhook = model<IPartnerWebhook>(
  'PartnerWebhook',
  partnerWebhookSchema,
);
export default PartnerWebhook;
