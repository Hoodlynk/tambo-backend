import { z } from 'zod';
import config from '../config/config';
import { WEBHOOK_EVENTS } from '../models/partnerWebhook.model';

/** Partner webhooks (B5). */

// plain http only where the server may also reach local addresses (dev/test);
// the transport re-checks both at send time, since this is not the last word
const webhookUrl = z
  .url({
    protocol: config.webhooks.allowLocalTargets ? /^https?$/ : /^https$/,
    message: 'Must be an https URL.',
  })
  .max(500);

export const webhookCreateSchema = z.object({
  url: webhookUrl,
  /**
   * Omitted: every event that exists today. Events added later are opt-in,
   * so a partner's handler never meets a type it did not ask for.
   */
  events: z
    .array(z.enum(WEBHOOK_EVENTS))
    .min(1)
    .transform((events) => [...new Set(events)])
    .optional(),
});
export type WebhookCreateInput = z.infer<typeof webhookCreateSchema>;

export const webhookIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid webhook id.'),
});
