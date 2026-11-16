import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';
import type { WebhookDeliveryType } from './partnerWebhook.model';

export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** How long the delivery log is kept for a partner to inspect. */
const LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * One event on its way to one endpoint (B5). The body is frozen at enqueue
 * so every retry carries the same bytes and the same event id: a partner
 * dedups on `Tambo-Event-Id`, and that only works if a retry is the same
 * event, not a fresh rendering of it.
 */
export interface IWebhookDelivery extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  partner: Types.ObjectId;
  webhook: Types.ObjectId;
  eventId: string;
  type: WebhookDeliveryType;
  /**
   * What makes two enqueues the same event for this endpoint, e.g. one
   * snapshot notice per burst however many frames arrive.
   */
  eventKey: string;
  body: string;
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt?: Date;
  /** A sender holds the row until then; a crashed sender's claim lapses. */
  lockedUntil?: Date;
  lastStatusCode?: number;
  lastError?: string;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const webhookDeliverySchema = new Schema<IWebhookDelivery>(
  {
    partner: { type: Schema.Types.ObjectId, ref: 'Partner', required: true },
    webhook: {
      type: Schema.Types.ObjectId,
      ref: 'PartnerWebhook',
      required: true,
    },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    eventKey: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: DELIVERY_STATUSES, default: 'pending' },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date },
    lockedUntil: { type: Date },
    lastStatusCode: { type: Number },
    lastError: { type: String },
    deliveredAt: { type: Date },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// the database dedups converging emitters, as the episode index does for openers
webhookDeliverySchema.index({ webhook: 1, eventKey: 1 }, { unique: true });
// the retry sweep
webhookDeliverySchema.index(
  { nextAttemptAt: 1 },
  { partialFilterExpression: { status: 'pending' } },
);
// a partner's delivery log, newest first
webhookDeliverySchema.index({ webhook: 1, createdAt: -1 });
webhookDeliverySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: LOG_RETENTION_SECONDS },
);

export const WebhookDelivery = model<IWebhookDelivery>(
  'WebhookDelivery',
  webhookDeliverySchema,
);
export default WebhookDelivery;
