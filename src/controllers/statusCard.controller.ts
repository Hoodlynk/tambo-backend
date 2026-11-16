import type { Request, Response } from 'express';
import * as statusCardService from '../services/statusCard.service';
import { authContext } from '../middlewares/auth.middleware';
import { deviceContext } from '../middlewares/deviceAuth.middleware';

/** The owner's card for one of their phones (Bearer). */
export const owner = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const card = await statusCardService.ownerCard(authContext(req).userId, id);
  // a stolen-phone card must never be served stale from a cache
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ card });
};

/** The phone's own card (X-Device-Token), for its widget. */
export const device = async (req: Request, res: Response): Promise<void> => {
  const card = await statusCardService.deviceCard(deviceContext(req));
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ card });
};
