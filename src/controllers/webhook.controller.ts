import type { Request, Response } from 'express';
import * as webhookService from '../services/webhook.service';
import { partnerContext } from '../middlewares/partnerAuth.middleware';
import type { WebhookCreateInput } from '../validation/webhook.schema';

export const create = async (req: Request, res: Response): Promise<void> => {
  const { webhook, secret } = await webhookService.create(
    partnerContext(req).partnerId,
    req.body as WebhookCreateInput,
  );
  // the signing secret appears here and on rotation, never in a listing
  res.status(201).json({ webhook: webhookService.toView(webhook), secret });
};

export const list = async (req: Request, res: Response): Promise<void> => {
  const webhooks = await webhookService.list(partnerContext(req).partnerId);
  res.status(200).json({ webhooks: webhooks.map(webhookService.toView) });
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  await webhookService.remove(partnerContext(req).partnerId, id);
  res.status(204).send();
};

export const rotateSecret = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const { webhook, secret } = await webhookService.rotateSecret(
    partnerContext(req).partnerId,
    id,
  );
  res.status(200).json({ webhook: webhookService.toView(webhook), secret });
};

export const ping = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const delivery = await webhookService.ping(partnerContext(req).partnerId, id);
  // queued and already on its way; the delivery log shows how it went
  res.status(202).json({ delivery: webhookService.toDeliveryView(delivery) });
};

export const deliveries = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const log = await webhookService.listDeliveries(
    partnerContext(req).partnerId,
    id,
  );
  res.status(200).json({ deliveries: log.map(webhookService.toDeliveryView) });
};
