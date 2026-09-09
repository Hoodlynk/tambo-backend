import { Router } from 'express';
import * as legalController from '../../controllers/legal.controller';
import { requireAuth } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate';
import { legalAcceptSchema } from '../../validation/legal.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// public: the app shows the T&C/privacy modal BEFORE the user has a session
router.get('/', legalController.documents);

// acceptance is an account act - it must be attributable to a signed-in user
router.get('/status', requireAuth, asyncHandler(legalController.status));
router.post(
  '/accept',
  requireAuth,
  validate({ body: legalAcceptSchema }),
  asyncHandler(legalController.accept),
);

export default router;
