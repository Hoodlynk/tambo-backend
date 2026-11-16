import crypto from 'crypto';
import type { Types } from 'mongoose';
import Partner from '../models/partner.model';
import PartnerWebhook, { WEBHOOK_EVENTS } from '../models/partnerWebhook.model';
import type {
  IPartnerWebhook,
  WebhookDeliveryType,
  WebhookEvent,
} from '../models/partnerWebhook.model';
import WebhookDelivery from '../models/webhookDelivery.model';
import type {
  DeliveryStatus,
  IWebhookDelivery,
} from '../models/webhookDelivery.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import { logger } from '../utils/logger';
import { post } from './webhook/transport';
import type { WebhookCreateInput } from '../validation/webhook.schema';

/**
 * Partner webhooks (B5): a partner system registers endpoints with its API
 * key and hears about its fleet - episodes opening and resolving, snapshot
 * bursts arriving, phones claiming. Every send is HMAC-signed, retried with
 * backoff, and logged for the partner to inspect.
 *
 * Delivery is at-least-once and fire-and-forget: a partner endpoint being
 * slow or down never delays the ingest or the episode that caused the event.
 */

/** Per partner. Fan-out per event stays bounded. */
export const MAX_WEBHOOKS = 5;

/** Wait before attempt n+1, after attempt n failed; ~45 h end to end. */
const BACKOFF_MINUTES = [1, 5, 30, 120, 360, 720, 1440];
export const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;

/** Long enough for one attempt to time out and be recorded. */
const LOCK_SECONDS = 60;

const SECRET_PREFIX = 'whsec_';
const DISPLAY_PREFIX_LENGTH = SECRET_PREFIX.length + 6;

export interface WebhookView {
  id: string;
  url: string;
  events: WebhookEvent[];
  secretPrefix: string;
  createdAt: string;
}

export interface DeliveryView {
  id: string;
  eventId: string;
  type: WebhookDeliveryType;
  status: DeliveryStatus;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export const toView = (webhook: IPartnerWebhook): WebhookView => ({
  id: webhook._id.toString(),
  url: webhook.url,
  events: webhook.events,
  secretPrefix: webhook.secretPrefix,
  createdAt: webhook.createdAt.toISOString(),
});

export const toDeliveryView = (delivery: IWebhookDelivery): DeliveryView => ({
  id: delivery._id.toString(),
  eventId: delivery.eventId,
  type: delivery.type,
  status: delivery.status,
  attempts: delivery.attempts,
  lastStatusCode: delivery.lastStatusCode ?? null,
  lastError: delivery.lastError ?? null,
  nextAttemptAt:
    delivery.status === 'pending'
      ? (delivery.nextAttemptAt?.toISOString() ?? null)
      : null,
  deliveredAt: delivery.deliveredAt?.toISOString() ?? null,
  createdAt: delivery.createdAt.toISOString(),
});

const newSecret = (): { secret: string; secretPrefix: string } => {
  const secret = `${SECRET_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  return { secret, secretPrefix: secret.slice(0, DISPLAY_PREFIX_LENGTH) };
};

const notFound = (): AppError =>
  AppError.notFound('Webhook not found.', 'webhook_not_found');

const getOwn = async (
  partnerId: string,
  webhookId: string,
): Promise<IPartnerWebhook> => {
  const webhook = await PartnerWebhook.findOne({
    _id: webhookId,
    partner: partnerId,
  });
  if (!webhook) throw notFound();
  return webhook;
};

// --- Endpoint management (partner API key) -----------------------------------

export const create = async (
  partnerId: string,
  input: WebhookCreateInput,
): Promise<{ webhook: IPartnerWebhook; secret: string }> => {
  if (
    (await PartnerWebhook.countDocuments({ partner: partnerId })) >=
    MAX_WEBHOOKS
  ) {
    throw AppError.conflict(
      `A partner may register at most ${MAX_WEBHOOKS} webhooks.`,
      'webhook_limit',
    );
  }
  const { secret, secretPrefix } = newSecret();
  const webhook = await PartnerWebhook.create({
    partner: partnerId,
    url: input.url,
    events: input.events ?? [...WEBHOOK_EVENTS],
    secret,
    secretPrefix,
  });
  return { webhook, secret };
};

export const list = (partnerId: string): Promise<IPartnerWebhook[]> =>
  PartnerWebhook.find({ partner: partnerId }).sort({ createdAt: 1 }).exec();

/** Deliveries still queued die with the endpoint; the log goes too. */
export const remove = async (
  partnerId: string,
  webhookId: string,
): Promise<void> => {
  const webhook = await getOwn(partnerId, webhookId);
  await WebhookDelivery.deleteMany({ webhook: webhook._id });
  await webhook.deleteOne();
};

/**
 * The old secret dies at once, retries included: a partner rotating because
 * the secret leaked must not keep accepting signatures made with it.
 */
export const rotateSecret = async (
  partnerId: string,
  webhookId: string,
): Promise<{ webhook: IPartnerWebhook; secret: string }> => {
  const webhook = await getOwn(partnerId, webhookId);
  const { secret, secretPrefix } = newSecret();
  webhook.secret = secret;
  webhook.secretPrefix = secretPrefix;
  await webhook.save();
  return { webhook, secret };
};

export const listDeliveries = async (
  partnerId: string,
  webhookId: string,
): Promise<IWebhookDelivery[]> => {
  const webhook = await getOwn(partnerId, webhookId);
  return WebhookDelivery.find({ webhook: webhook._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .exec();
};

// --- Sending -----------------------------------------------------------------

/**
 * One attempt at a delivery, if it is due and nobody else holds it. The claim
 * is a single conditional write, so the immediate send and the sweep can
 * never both send the same attempt.
 */
const attempt = async (deliveryId: Types.ObjectId): Promise<void> => {
  const now = new Date();
  const delivery = await WebhookDelivery.findOneAndUpdate(
    {
      _id: deliveryId,
      status: 'pending',
      nextAttemptAt: { $lte: now },
      $or: [
        { lockedUntil: { $exists: false } },
        { lockedUntil: { $lte: now } },
      ],
    },
    {
      $set: { lockedUntil: new Date(now.getTime() + LOCK_SECONDS * 1000) },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
  if (!delivery) return;

  const webhook = await PartnerWebhook.findById(delivery.webhook).select(
    '+secret',
  );
  if (!webhook) {
    // removed between enqueue and send; its deliveries are being deleted too
    await WebhookDelivery.deleteOne({ _id: delivery._id });
    return;
  }

  const outcome = await post({
    url: webhook.url,
    secret: webhook.secret,
    eventId: delivery.eventId,
    type: delivery.type,
    body: delivery.body,
  });

  if (outcome.ok) {
    await WebhookDelivery.updateOne(
      { _id: delivery._id },
      {
        $set: {
          status: 'delivered',
          deliveredAt: new Date(),
          lastStatusCode: outcome.statusCode,
        },
        $unset: { lockedUntil: 1, nextAttemptAt: 1, lastError: 1 },
      },
    );
    return;
  }

  const exhausted = delivery.attempts >= MAX_ATTEMPTS;
  const waitMinutes = BACKOFF_MINUTES[delivery.attempts - 1] ?? 0;
  await WebhookDelivery.updateOne(
    { _id: delivery._id },
    {
      $set: {
        status: exhausted ? 'failed' : 'pending',
        lastError: outcome.error,
        ...(outcome.statusCode ? { lastStatusCode: outcome.statusCode } : {}),
        ...(exhausted
          ? {}
          : {
              nextAttemptAt: new Date(Date.now() + waitMinutes * 60 * 1000),
            }),
      },
      $unset: {
        lockedUntil: 1,
        ...(exhausted ? { nextAttemptAt: 1 } : {}),
        ...(outcome.statusCode ? {} : { lastStatusCode: 1 }),
      },
    },
  );
  // the URL and status only: a partner's response body is theirs, not our logs'
  logger.warn(
    {
      webhookId: webhook._id.toString(),
      eventId: delivery.eventId,
      attempt: delivery.attempts,
      error: outcome.error,
    },
    exhausted ? 'webhook delivery abandoned' : 'webhook delivery failed',
  );
};

const sendSoon = (deliveryId: Types.ObjectId): void => {
  void attempt(deliveryId).catch((error) => {
    logger.error({ err: error }, 'webhook attempt crashed');
  });
};

/**
 * Queues one event for every endpoint of the partner subscribed to it and
 * sends each at once. `eventKey` makes enqueueing idempotent per endpoint, so
 * converging callers and retried ingests never send the same event twice.
 */
export const emit = async (
  partnerId: Types.ObjectId,
  type: WebhookEvent,
  eventKey: string,
  data: Record<string, unknown>,
): Promise<void> => {
  const webhooks = await PartnerWebhook.find({
    partner: partnerId,
    events: type,
  }).select('_id');
  if (webhooks.length === 0) return;

  const partner = await Partner.findById(partnerId).select('code');
  if (!partner) return;

  const eventId = crypto.randomUUID();
  const body = JSON.stringify({
    id: eventId,
    type,
    createdAt: new Date().toISOString(),
    partner: partner.code,
    data,
  });

  for (const webhook of webhooks) {
    try {
      const delivery = await WebhookDelivery.create({
        partner: partnerId,
        webhook: webhook._id,
        eventId,
        type,
        eventKey,
        body,
        nextAttemptAt: new Date(),
      });
      sendSoon(delivery._id);
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }
};

/** Fire-and-forget wrapper for call sites: events never fail their cause. */
export const notify = (
  partnerId: Types.ObjectId | undefined,
  type: WebhookEvent,
  eventKey: string,
  data: () => Record<string, unknown>,
): void => {
  if (!partnerId) return;
  void emit(partnerId, type, eventKey, data()).catch((error) => {
    logger.error({ err: error, type }, 'failed to enqueue webhook event');
  });
};

/** A ping to one endpoint, whatever it subscribes to: the integration check. */
export const ping = async (
  partnerId: string,
  webhookId: string,
): Promise<IWebhookDelivery> => {
  const webhook = await getOwn(partnerId, webhookId);
  const partner = await Partner.findById(partnerId).select('code');
  const eventId = crypto.randomUUID();
  const delivery = await WebhookDelivery.create({
    partner: webhook.partner,
    webhook: webhook._id,
    eventId,
    type: 'ping',
    eventKey: `ping:${eventId}`,
    body: JSON.stringify({
      id: eventId,
      type: 'ping',
      createdAt: new Date().toISOString(),
      partner: partner?.code ?? null,
      data: { webhookId: webhook._id.toString() },
    }),
    nextAttemptAt: new Date(),
  });
  sendSoon(delivery._id);
  return delivery;
};

/**
 * The retry sweep server.ts runs on an interval: every pending delivery that
 * is due, including first attempts lost to a restart. Sequential and bounded
 * per pass so a partner outage cannot flood the event loop.
 */
export const dispatchDue = async (limit = 50): Promise<number> => {
  const now = new Date();
  const due = await WebhookDelivery.find({
    status: 'pending',
    nextAttemptAt: { $lte: now },
    $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
  })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .select('_id');
  for (const delivery of due) await attempt(delivery._id);
  return due.length;
};
