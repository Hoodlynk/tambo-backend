import type { Request, Response } from 'express';
import * as deviceService from '../services/device.service';
import * as episodeService from '../services/episode.service';
import * as evidenceService from '../services/evidence.service';
import { authContext } from '../middlewares/auth.middleware';
import type {
  DeviceInput,
  DeviceUpdateInput,
} from '../validation/device.schema';

export const register = async (req: Request, res: Response): Promise<void> => {
  const { device, ingestToken } = await deviceService.register(
    authContext(req).userId,
    req.body as DeviceInput,
  );
  // the token appears in this response and never again - only its hash is stored
  res.status(201).json({ device: device.toJSON(), ingestToken });
};

export const list = async (req: Request, res: Response): Promise<void> => {
  const devices = await deviceService.list(authContext(req).userId);
  res.status(200).json({ devices: devices.map((device) => device.toJSON()) });
};

export const get = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const device = await deviceService.getOwned(authContext(req).userId, id);
  res.status(200).json({ device: device.toJSON() });
};

export const activity = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const device = await deviceService.getOwned(authContext(req).userId, id);
  const report = await evidenceService.unlockActivity(device);
  res.status(200).json({ activity: report });
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const device = await deviceService.update(
    authContext(req).userId,
    id,
    req.body as DeviceUpdateInput,
  );
  res.status(200).json({ device: device.toJSON() });
};

export const remove = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  await deviceService.remove(authContext(req).userId, id);
  res.status(204).send();
};

export const rotateToken = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const ingestToken = await deviceService.rotateIngestToken(
    authContext(req).userId,
    id,
  );
  res.status(200).json({ ingestToken });
};

export const revokeToken = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  await deviceService.revokeIngestToken(authContext(req).userId, id);
  res.status(204).send();
};

export const markStolen = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const { note } = req.body as { note?: string };
  const { episode, created } = await episodeService.markStolen(
    authContext(req).userId,
    id,
    note,
  );
  // 201 when this call opened the episode; 200 when converging on an open one
  res.status(created ? 201 : 200).json({ episode: episode.toJSON() });
};

export const markRecovered = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const episode = await episodeService.markRecovered(
    authContext(req).userId,
    id,
  );
  res.status(200).json({ episode: episode.toJSON() });
};
