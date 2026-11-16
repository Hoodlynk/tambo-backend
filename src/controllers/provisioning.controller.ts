import type { Request, Response } from 'express';
import * as provisioningService from '../services/provisioning.service';
import { authContext } from '../middlewares/auth.middleware';
import { deviceContext } from '../middlewares/deviceAuth.middleware';
import { partnerContext } from '../middlewares/partnerAuth.middleware';
import type {
  ClaimInput,
  LinkInput,
  ProvisionInput,
} from '../validation/provisioning.schema';

// --- Partner systems (X-Api-Key) ---------------------------------------------

export const provision = async (req: Request, res: Response): Promise<void> => {
  const { devices } = req.body as ProvisionInput;
  const results = await provisioningService.provision(
    partnerContext(req).partnerId,
    devices,
  );
  // tokens appear in this response and never again - only hashes are stored
  res.status(200).json({ devices: results });
};

export const partnerDevice = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const read = await provisioningService.partnerDevice(
    partnerContext(req).partnerId,
    id,
  );
  res.status(200).json(read);
};

export const partnerResolve = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { id } = req.params as { id: string };
  const episode = await provisioningService.partnerResolve(
    partnerContext(req).partnerId,
    id,
  );
  res.status(200).json({ episode: episode.toJSON() });
};

// --- The phone and its owner -------------------------------------------------

export const claim = async (req: Request, res: Response): Promise<void> => {
  const { device, ingestToken, created } = await provisioningService.claim(
    req.body as ClaimInput,
  );
  res
    .status(created ? 201 : 200)
    .json({ device: device.toJSON(), ingestToken });
};

export const link = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const device = await provisioningService.link(
    authContext(req).userId,
    id,
    deviceContext(req),
    req.body as LinkInput,
  );
  res.status(200).json({ device: device.toJSON() });
};
