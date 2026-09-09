import { Router } from 'express';
import * as episodeController from '../../controllers/episode.controller';
import * as packController from '../../controllers/pack.controller';
import { rateLimit } from '../../middlewares/rateLimit';
import { requireAuth } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate';
import {
  episodeIdSchema,
  episodeListQuerySchema,
} from '../../validation/device.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

router.use(requireAuth);

router.get(
  '/',
  validate({ query: episodeListQuerySchema }),
  asyncHandler(episodeController.list),
);
router.get(
  '/:id',
  validate({ params: episodeIdSchema }),
  asyncHandler(episodeController.get),
);

// the location trail (F3): ordered fixes, static/moving, familiar context
router.get(
  '/:id/trail',
  validate({ params: episodeIdSchema }),
  asyncHandler(episodeController.trail),
);

// --- The evidence pack (F-C): the dossier this product exists to produce ----
router.get(
  '/:id/pack',
  validate({ params: episodeIdSchema }),
  asyncHandler(packController.getJson),
);
router.get(
  '/:id/pack.pdf',
  validate({ params: episodeIdSchema }),
  asyncHandler(packController.getPdf),
);
router.post(
  '/:id/send-pack',
  validate({ params: episodeIdSchema }),
  rateLimit({ name: 'packSend' }),
  asyncHandler(packController.send),
);

export default router;
