import type { Request, Response } from 'express';
import * as episodeService from '../services/episode.service';
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
