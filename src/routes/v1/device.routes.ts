import { Router } from 'express';
import * as deviceController from '../../controllers/device.controller';
import { requireAuth } from '../../middlewares/auth.middleware';
import { requireLegalAcceptance } from '../../middlewares/legalGate.middleware';
import { validate } from '../../middlewares/validate';
import {
  deviceIdSchema,
  deviceSchema,
  deviceUpdateSchema,
  markStolenSchema,
} from '../../validation/device.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// everything device-management is owner-only
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

// owner-facing failed-unlock report ("has anyone been trying my PIN?")
router.get(
  '/:id/activity',
  validate({ params: deviceIdSchema }),
  asyncHandler(deviceController.activity),
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

export default router;
