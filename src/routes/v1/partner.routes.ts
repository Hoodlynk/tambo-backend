import { Router } from 'express';
import * as partnerController from '../../controllers/partner.controller';
import * as provisioningController from '../../controllers/provisioning.controller';
import * as webhookController from '../../controllers/webhook.controller';
import { requirePartnerApiKey } from '../../middlewares/partnerAuth.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { deviceIdSchema } from '../../validation/device.schema';
import { provisionSchema } from '../../validation/provisioning.schema';
import {
  webhookCreateSchema,
  webhookIdSchema,
} from '../../validation/webhook.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// partner systems authenticate with their API key
router.use(requirePartnerApiKey);

const perKey = rateLimit({
  name: 'partnerApi',
  subject: (req) => req.partner?.apiKeyId ?? '',
});

// the integration smoke test: "is my key live, and whose is it?"
router.get('/me', perKey, asyncHandler(partnerController.me));

// device-first enrolment (B4): one call per production lot
router.post(
  '/devices',
  validate({ body: provisionSchema }),
  perKey,
  asyncHandler(provisioningController.provision),
);
router.get(
  '/devices/:id',
  validate({ params: deviceIdSchema }),
  perKey,
  asyncHandler(provisioningController.partnerDevice),
);
router.post(
  '/devices/:id/mark-recovered',
  validate({ params: deviceIdSchema }),
  perKey,
  asyncHandler(provisioningController.partnerResolve),
);

// webhooks (B5): the partner manages its own endpoints with its own key
router.post(
  '/webhooks',
  validate({ body: webhookCreateSchema }),
  perKey,
  asyncHandler(webhookController.create),
);
router.get('/webhooks', perKey, asyncHandler(webhookController.list));
router.delete(
  '/webhooks/:id',
  validate({ params: webhookIdSchema }),
  perKey,
  asyncHandler(webhookController.remove),
);
router.post(
  '/webhooks/:id/rotate-secret',
  validate({ params: webhookIdSchema }),
  perKey,
  asyncHandler(webhookController.rotateSecret),
);
router.post(
  '/webhooks/:id/ping',
  validate({ params: webhookIdSchema }),
  perKey,
  asyncHandler(webhookController.ping),
);
router.get(
  '/webhooks/:id/deliveries',
  validate({ params: webhookIdSchema }),
  perKey,
  asyncHandler(webhookController.deliveries),
);

export default router;
