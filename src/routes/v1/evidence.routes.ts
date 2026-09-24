import express, { Router } from 'express';
import config from '../../config/config';
import * as evidenceController from '../../controllers/evidence.controller';
import { requireDeviceToken } from '../../middlewares/deviceAuth.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import {
  ingestSchema,
  mediaParamsSchema,
} from '../../validation/evidence.schema';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

/**
 * Everything here authenticates as a DEVICE (X-Device-Token), never as a user.
 * These routes parse their own bodies: batches are bigger than the app-wide
 * 100kb JSON cap, and photos arrive as raw bytes.
 */
router.use(requireDeviceToken);

router.post(
  '/',
  express.json({ limit: '1mb' }),
  validate({ body: ingestSchema }),
  rateLimit({
    name: 'evidenceIngest',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(evidenceController.ingest),
);

// no body; registered before '/:envelopeId/media' only for readability - the
// paths cannot collide (that one needs a second segment)
router.post(
  '/heartbeat',
  rateLimit({
    name: 'heartbeat',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(evidenceController.heartbeat),
);

router.post(
  '/:envelopeId/media',
  // accept whatever content-type the camera produced; the cap is the guard
  express.raw({ type: () => true, limit: config.evidence.maxMediaBytes }),
  validate({ params: mediaParamsSchema }),
  rateLimit({
    name: 'mediaUpload',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(evidenceController.uploadMedia),
);

export default router;
