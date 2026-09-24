import { Router } from 'express';
import * as alertActionController from '../../controllers/alertAction.controller';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import { alertActionTokenSchema } from '../../validation/device.schema';
import { asyncHandler } from '../../utils/asyncHandler';

/**
 * PUBLIC: the link in a quiet alert email is its own credential (see
 * AlertActionToken). Opened in a browser, never by the app.
 */
const router = Router();

router.get(
  '/:token',
  validate({ params: alertActionTokenSchema }),
  rateLimit({ name: 'alertAction' }),
  asyncHandler(alertActionController.show),
);
router.post(
  '/:token',
  validate({ params: alertActionTokenSchema }),
  rateLimit({ name: 'alertAction' }),
  asyncHandler(alertActionController.confirm),
);

export default router;
