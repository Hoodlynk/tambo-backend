import { Router } from 'express';
import * as buddyController from '../../controllers/buddy.controller';
import { requireAuth } from '../../middlewares/auth.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import {
  deviceIdSchema,
  markStolenSchema,
} from '../../validation/device.schema';
import { asyncHandler } from '../../utils/asyncHandler';

/**
 * The buddy's side of an ACCEPTED link: the people I protect, and the one
 * action I can take for them - reporting their phone stolen when they have no
 * other phone to do it from.
 */
const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(buddyController.listProtected));
router.post(
  '/devices/:id/report-stolen',
  validate({ params: deviceIdSchema, body: markStolenSchema }),
  rateLimit({ name: 'buddyReport' }),
  asyncHandler(buddyController.reportStolen),
);

export default router;
