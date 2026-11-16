import type { Request, Response } from 'express';
import * as partnerService from '../services/partner.service';
import { authContext } from '../middlewares/auth.middleware';
import { partnerContext } from '../middlewares/partnerAuth.middleware';
import type {
  PartnerCreateInput,
  PartnerUpdateInput,
} from '../validation/partner.schema';

// --- Admin catalogue ---------------------------------------------------------

export const create = async (req: Request, res: Response): Promise<void> => {
  const partner = await partnerService.create(req.body as PartnerCreateInput);
  res.status(201).json({ partner: partner.toJSON() });
};

export const list = async (_req: Request, res: Response): Promise<void> => {
  const partners = await partnerService.list();
  res.status(200).json({ partners: partners.map((p) => p.toJSON()) });
};

export const get = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const partner = await partnerService.get(id);
  res.status(200).json({ partner: partner.toJSON() });
};

export const update = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const partner = await partnerService.update(
    id,
    req.body as PartnerUpdateInput,
  );
  res.status(200).json({ partner: partner.toJSON() });
};

export const issueKey = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const { name } = req.body as { name: string };
  const { key, apiKey } = await partnerService.issueKey(
    id,
    authContext(req).userId,
    name,
  );
  // the key appears in this response and never again - only its hash is stored
  res.status(201).json({ key, apiKey });
};

export const listKeys = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  res.status(200).json({ keys: await partnerService.listKeys(id) });
};

export const revokeKey = async (req: Request, res: Response): Promise<void> => {
  const { id, keyId } = req.params as { id: string; keyId: string };
  await partnerService.revokeKey(id, keyId, authContext(req).userId);
  res.status(204).send();
};

// --- Partner systems (X-Api-Key) ---------------------------------------------

export const me = async (req: Request, res: Response): Promise<void> => {
  const partner = await partnerService.get(partnerContext(req).partnerId);
  res.status(200).json({ partner: partnerService.toSummary(partner) });
};
