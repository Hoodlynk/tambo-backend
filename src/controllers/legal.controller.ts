import type { Request, Response } from 'express';
import { authContext } from '../middlewares/auth.middleware';
import * as legalService from '../services/legal.service';
import type { LegalAcceptInput } from '../validation/legal.schema';

/** Public: the current T&C + privacy versions and where they live. */
export const documents = (_req: Request, res: Response): void => {
  res.status(200).json({ documents: legalService.currentDocuments() });
};

/** What this user has accepted vs current - the app's post-login modal cue. */
export const status = async (req: Request, res: Response): Promise<void> => {
  const documents = await legalService.statusFor(authContext(req).userId);
  res.status(200).json({ documents });
};

export const accept = async (req: Request, res: Response): Promise<void> => {
  const document = await legalService.accept(
    authContext(req).userId,
    req.body as LegalAcceptInput,
    { userAgent: req.get('user-agent'), ip: req.ip },
  );
  res.status(200).json({ document });
};
