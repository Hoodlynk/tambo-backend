import { Router } from 'express';
import * as clientConfigController from '../../controllers/clientConfig.controller';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { clientConfigQuerySchema } from '../../validation/partner.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// public: the app calls this at launch, before anyone has signed in
router.get(
  '/config',
  validate({ query: clientConfigQuerySchema }),
  rateLimit({ name: 'clientConfig' }),
  asyncHandler(clientConfigController.get),
);

export default router;
