import type { Request, Response } from 'express';
import config from '../config/config';
import * as evidenceService from '../services/evidence.service';
import { deviceContext } from '../middlewares/deviceAuth.middleware';
import { AppError } from '../utils/appError';
import type { IngestInput } from '../validation/evidence.schema';

export const ingest = async (req: Request, res: Response): Promise<void> => {
  const { envelopes } = req.body as IngestInput;
  const result = await evidenceService.ingestBatch(
    deviceContext(req),
    envelopes,
  );
  // 200 even with per-envelope rejections: the client reads the ACK list and
  // flips acked/duplicate envelopes to ACKED, retrying only what failed
  res.status(200).json(result);
};

/** The phone's periodic "still here" when it has nothing to upload. */
export const heartbeat = async (req: Request, res: Response): Promise<void> => {
  const result = await evidenceService.heartbeat(deviceContext(req));
  res.status(200).json({ ok: true, ...result });
};

export const uploadMedia = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { envelopeId } = req.params as { envelopeId: string };

  const declaredSha256 = req.get('x-content-sha256');
  if (!declaredSha256 || !/^[a-f\d]{64}$/i.test(declaredSha256)) {
    throw AppError.badRequest(
      'Send the media hash in X-Content-Sha256 (64 hex characters).',
      'missing_content_hash',
    );
  }

  const content = req.body as Buffer;
  if (!Buffer.isBuffer(content) || content.length === 0) {
    throw AppError.badRequest(
      'Send the raw media bytes as the request body.',
      'empty_media',
    );
  }
  if (content.length > config.evidence.maxMediaBytes) {
    throw new AppError(413, 'Media is too large.', 'payload_too_large');
  }

  const ack = await evidenceService.attachMedia(
    deviceContext(req),
    envelopeId,
    content,
    req.get('content-type') ?? 'application/octet-stream',
    declaredSha256,
  );

  res.status(ack.stored ? 201 : 200).json(ack);
};
