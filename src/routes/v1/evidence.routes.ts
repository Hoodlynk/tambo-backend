import express, { Router } from 'express';
import config from '../../config/config';
import * as deviceCommandController from '../../controllers/deviceCommand.controller';
import * as evidenceController from '../../controllers/evidence.controller';
import * as pushTokenController from '../../controllers/pushToken.controller';
import * as statusCardController from '../../controllers/statusCard.controller';
import { requireDeviceToken } from '../../middlewares/deviceAuth.middleware';
import { rateLimit } from '../../middlewares/rateLimit';
import { validate } from '../../middlewares/validate';
import {
  ingestSchema,
  mediaParamsSchema,
} from '../../validation/evidence.schema';
import { pushTokenRegisterSchema } from '../../validation/pushToken.schema';
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

// remote commands (B2): the poll a wake-up push (or the trail timer) triggers
router.get(
  '/commands',
  rateLimit({
    name: 'commandPoll',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(deviceCommandController.poll),
);

// the phone's own status card (B5), for its widget; discreet by design
router.get(
  '/status',
  rateLimit({
    name: 'deviceStatusCard',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(statusCardController.device),
);

// the phone's own push registration, on the credential that survives theft:
// an FCM token rotating after the owner's session was revoked still lands
router.post(
  '/push-token',
  express.json(),
  validate({ body: pushTokenRegisterSchema }),
  rateLimit({
    name: 'devicePushToken',
    subject: (req) => req.device?._id.toString() ?? '',
  }),
  asyncHandler(pushTokenController.registerForDevice),
);

export default router;
