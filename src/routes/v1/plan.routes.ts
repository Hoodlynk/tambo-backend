import { Router } from 'express';
import * as planController from '../../controllers/plan.controller';
import { requireAuth, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate';
import { planSetSchema, planUserIdSchema } from '../../validation/plan.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();
router.use(requireAuth);

// the Settings "Subscription" row reads this
router.get('/', asyncHandler(planController.get));

// manual/support plan changes until the Play Billing webhook lands (3b);
// the webhook will call the same service function
router.patch(
  '/:userId',
  requireRole('admin'),
  validate({ params: planUserIdSchema, body: planSetSchema }),
  asyncHandler(planController.adminSet),
);

export default router;
