import { Router } from 'express';
import * as partnerController from '../../controllers/partner.controller';
import { requireAuth, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate';
import {
  partnerCreateSchema,
  partnerIdSchema,
  partnerKeyCreateSchema,
  partnerKeyParamsSchema,
  partnerUpdateSchema,
} from '../../validation/partner.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// the partner catalogue and its credentials are Tambo staff only
router.use(requireAuth, requireRole('admin'));

router.post(
  '/',
  validate({ body: partnerCreateSchema }),
  asyncHandler(partnerController.create),
);
router.get('/', asyncHandler(partnerController.list));
router.get(
  '/:id',
  validate({ params: partnerIdSchema }),
  asyncHandler(partnerController.get),
);
router.patch(
  '/:id',
  validate({ params: partnerIdSchema, body: partnerUpdateSchema }),
  asyncHandler(partnerController.update),
);

router.post(
  '/:id/keys',
  validate({ params: partnerIdSchema, body: partnerKeyCreateSchema }),
  asyncHandler(partnerController.issueKey),
);
router.get(
  '/:id/keys',
  validate({ params: partnerIdSchema }),
  asyncHandler(partnerController.listKeys),
);
router.delete(
  '/:id/keys/:keyId',
  validate({ params: partnerKeyParamsSchema }),
  asyncHandler(partnerController.revokeKey),
);

export default router;
