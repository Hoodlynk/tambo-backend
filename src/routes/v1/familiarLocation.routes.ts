import { Router } from 'express';
import * as familiarLocationController from '../../controllers/familiarLocation.controller';
import { requireAuth } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate';
import {
  familiarLocationIdSchema,
  familiarLocationSchema,
  familiarLocationUpdateSchema,
} from '../../validation/familiarLocation.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// owner-entered places; interpretation-only context for trail reports
router.use(requireAuth);

router.get('/', asyncHandler(familiarLocationController.list));
router.post(
  '/',
  validate({ body: familiarLocationSchema }),
  asyncHandler(familiarLocationController.create),
);
router.patch(
  '/:id',
  validate({ params: familiarLocationIdSchema, body: familiarLocationUpdateSchema }),
  asyncHandler(familiarLocationController.update),
);
router.delete(
  '/:id',
  validate({ params: familiarLocationIdSchema }),
  asyncHandler(familiarLocationController.remove),
);

export default router;
