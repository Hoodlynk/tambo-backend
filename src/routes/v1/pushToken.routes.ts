import { Router } from 'express';
import * as pushTokenController from '../../controllers/pushToken.controller';
import { requireAuth } from '../../middlewares/auth.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import {
  pushTokenRegisterSchema,
  pushTokenUnregisterSchema,
} from '../../validation/pushToken.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();
router.use(requireAuth);

// the app re-registers on every start; the upsert makes that free
router.post(
  '/',
  validate({ body: pushTokenRegisterSchema }),
  rateLimit({ name: 'pushTokenRegister' }),
  asyncHandler(pushTokenController.register),
);

// body (not a path param): FCM tokens contain characters that fight URLs
router.delete(
  '/',
  validate({ body: pushTokenUnregisterSchema }),
  asyncHandler(pushTokenController.unregister),
);

export default router;
