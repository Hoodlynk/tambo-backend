import type { Request, Response } from 'express';
import * as clientConfigService from '../services/clientConfig.service';
import type { ClientConfigQuery } from '../validation/partner.schema';

export const get = async (req: Request, res: Response): Promise<void> => {
  const { platform, partner } = req.query as unknown as ClientConfigQuery;
  const config = await clientConfigService.forClient(
    platform,
    partner,
    req.client?.version,
  );
  // short and shared: a CDN may absorb the app-start stampede, and a policy
  // or brand change still lands within minutes
  res.set('Cache-Control', 'public, max-age=300');
  res.set('Vary', 'X-Client-Version');
  res.status(200).json({ config });
};
