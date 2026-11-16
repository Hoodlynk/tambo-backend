import { Router } from 'express';
import * as deviceController from '../../controllers/device.controller';
import * as deviceCommandController from '../../controllers/deviceCommand.controller';
import * as provisioningController from '../../controllers/provisioning.controller';
import * as statusCardController from '../../controllers/statusCard.controller';
import { authContext, requireAuth } from '../../middlewares/auth.middleware';
import { requireDeviceToken } from '../../middlewares/deviceAuth.middleware';
import { requireLegalAcceptance } from '../../middlewares/legalGate.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import {
  commandCreateSchema,
  commandParamsSchema,
} from '../../validation/command.schema';
import {
  deviceIdSchema,
  deviceSchema,
  deviceUpdateSchema,
  markStolenSchema,
} from '../../validation/device.schema';
import { claimSchema, linkSchema } from '../../validation/provisioning.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// a provisioned phone claims its ingest token before anyone has signed in
// (B4); the provisioning token in the body is the credential
router.post(
  '/claim',
  validate({ body: claimSchema }),
  rateLimit({ name: 'deviceClaim' }),
  asyncHandler(provisioningController.claim),
);

// everything else device-management is owner-only
router.use(requireAuth);

// enrolment starts unlock/location collection - gated on current T&C +
// privacy acceptance (docs/legal-api.md). Managing an EXISTING device is not:
// a version bump must never brick an already-protected phone mid-theft.
router.post(
  '/',
  requireLegalAcceptance,
  validate({ body: deviceSchema }),
  asyncHandler(deviceController.register),
);
router.get('/', asyncHandler(deviceController.list));
router.get(
  '/:id',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.get),
);

// a signed-in person takes ownership of the provisioned phone they hold: the
// session says who, the device token proves which phone. Linking starts
// collection on their behalf, so it is legal-gated like enrolment.
router.post(
  '/:id/link',
  requireLegalAcceptance,
  requireDeviceToken,
  validate({ params: deviceIdSchema, body: linkSchema }),
  rateLimit({
    name: 'deviceLink',
    subject: (req) => authContext(req).userId,
  }),
  asyncHandler(provisioningController.link),
);

// owner-facing failed-unlock report ("has anyone been trying my PIN?")
router.get(
  '/:id/activity',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.activity),
);
// the status card (B5): what the owner's widget shows about this phone
router.get(
  '/:id/status-card',
  validate({ params: deviceIdSchema }),
  asyncHandler(statusCardController.owner),
);
router.patch(
  '/:id',
  validate({ params: deviceIdSchema, body: deviceUpdateSchema }),
  asyncHandler(deviceController.update),
);
router.delete(
  '/:id',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.remove),
);

router.post(
  '/:id/token',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.rotateToken),
);
router.delete(
  '/:id/token',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.revokeToken),
);

router.post(
  '/:id/mark-stolen',
  validate({ params: deviceIdSchema, body: markStolenSchema }),
  asyncHandler(deviceController.markStolen),
);
router.post(
  '/:id/mark-recovered',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.markRecovered),
);

// remote commands (B2): only while an episode is open, enforced in the service
router.post(
  '/:id/commands',
  validate({ params: deviceIdSchema, body: commandCreateSchema }),
  rateLimit({
    name: 'deviceCommand',
    subject: (req) => authContext(req).userId,
  }),
  asyncHandler(deviceCommandController.create),
);
router.get(
  '/:id/commands',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceCommandController.list),
);
router.post(
  '/:id/commands/:commandId/cancel',
  validate({ params: commandParamsSchema }),
  asyncHandler(deviceCommandController.cancel),
);

export default router;
