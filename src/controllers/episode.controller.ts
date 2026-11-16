import type { Request, Response } from 'express';
import * as episodeService from '../services/episode.service';
import * as snapshotService from '../services/snapshot.service';
import * as trailService from '../services/trail.service';
import { authContext } from '../middlewares/auth.middleware';

export const list = async (req: Request, res: Response): Promise<void> => {
  const { deviceId } = req.query as { deviceId?: string };
  const episodes = await episodeService.list(authContext(req).userId, deviceId);
  res
    .status(200)
    .json({ episodes: episodes.map((episode) => episode.toJSON()) });
};

export const get = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const episode = await episodeService.getOwned(authContext(req).userId, id);
  res.status(200).json({ episode: episode.toJSON() });
};

export const trail = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const trail = await trailService.getTrail(authContext(req).userId, id);
  res.status(200).json({
    trail: {
      movement: trail.movement,
      points: trail.points.map((point) => ({
        at: point.at.toISOString(),
        capturedAt: point.capturedAt.toISOString(),
        source: point.source,
        lat: point.lat,
        lng: point.lng,
        ...(point.accuracyM !== undefined
          ? { accuracyM: point.accuracyM }
          : {}),
        familiar: point.familiar,
      })),
      leftFamiliar: trail.leftFamiliar
        ? {
            label: trail.leftFamiliar.label,
            at: trail.leftFamiliar.at.toISOString(),
          }
        : null,
    },
  });
};

export const snapshots = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const result = await snapshotService.getSnapshots(
    authContext(req).userId,
    id,
  );
  res.status(200).json({
    snapshots: {
      summary: result.summary,
      bursts: result.bursts.map((burst) => ({
        burstId: burst.burstId,
        trigger: burst.trigger,
        at: burst.at.toISOString(),
        capturedAt: burst.capturedAt.toISOString(),
        location: burst.location,
        familiar: burst.familiar,
        expectedFrames: burst.expectedFrames,
        cameras: burst.cameras,
        frames: burst.frames.map((frame) => ({
          envelopeId: frame.envelopeId,
          seq: frame.seq,
          camera: frame.camera,
          receivedAt: frame.receivedAt.toISOString(),
          capturedAt: frame.capturedAt.toISOString(),
          sha256: frame.sha256,
          ...(frame.bytes !== undefined ? { bytes: frame.bytes } : {}),
          ...(frame.contentType ? { contentType: frame.contentType } : {}),
          hasMedia: frame.hasMedia,
          ...(frame.headingDeg !== undefined
            ? { headingDeg: frame.headingDeg }
            : {}),
          // relative on purpose: the client already knows the API origin
          mediaPath: `/api/v1/episodes/${id}/snapshots/${frame.envelopeId}`,
        })),
      })),
    },
  });
};

export const snapshotMedia = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id, envelopeId } = req.params as { id: string; envelopeId: string };
  const media = await snapshotService.openSnapshotMedia(
    authContext(req).userId,
    id,
    envelopeId,
  );
  res.status(200);
  res.setHeader('Content-Type', media.contentType);
  if (media.bytes > 0) res.setHeader('Content-Length', String(media.bytes));
  res.setHeader('X-Content-Sha256', media.sha256);
  // evidence is immutable once stored: the hash IS the version
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('Content-Disposition', `inline; filename="${envelopeId}"`);
  await new Promise<void>((resolve, reject) => {
    media.stream.on('error', reject);
    media.stream.on('end', resolve);
    media.stream.pipe(res);
  });
};
