import type { Request, Response } from 'express';
import * as planService from '../services/plan.service';
import { authContext } from '../middlewares/auth.middleware';
import type { PlanSetInput } from '../validation/plan.schema';

export const get = async (req: Request, res: Response): Promise<void> => {
  const plan = await planService.getForUser(authContext(req).userId);
  res.status(200).json({ plan });
};

export const adminSet = async (req: Request, res: Response): Promise<void> => {
  const { userId } = req.params as { userId: string };
  const { plan, expiresAt, source } = req.body as PlanSetInput;
  const view = await planService.setPlan(
    userId,
    plan,
    expiresAt ? new Date(expiresAt) : undefined,
    source,
  );
  res.status(200).json({ plan: view });
};
