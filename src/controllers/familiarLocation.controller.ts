import type { Request, Response } from 'express';
import * as familiarLocationService from '../services/familiarLocation.service';
import { authContext } from '../middlewares/auth.middleware';
import type {
  FamiliarLocationInput,
  FamiliarLocationUpdateInput,
} from '../validation/familiarLocation.schema';

export const create = async (req: Request, res: Response): Promise<void> => {
  const location = await familiarLocationService.create(
    authContext(req).userId,
    req.body as FamiliarLocationInput,
  );
  res.status(201).json({ location: location.toJSON() });
};

export const list = async (req: Request, res: Response): Promise<void> => {
  const locations = await familiarLocationService.list(authContext(req).userId);
  res
    .status(200)
    .json({ locations: locations.map((location) => location.toJSON()) });
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const location = await familiarLocationService.update(
    authContext(req).userId,
    id,
    req.body as FamiliarLocationUpdateInput,
  );
  res.status(200).json({ location: location.toJSON() });
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  await familiarLocationService.remove(authContext(req).userId, id);
  res.status(204).send();
};
