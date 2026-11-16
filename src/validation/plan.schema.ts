import { z } from 'zod';
import { PLAN_SOURCES, USER_PLANS } from '../models/user.model';

export const planSetSchema = z.object({
  plan: z.enum(USER_PLANS),
  /** ISO timestamp; only meaningful (and only kept) for paid plans. */
  expiresAt: z.iso.datetime().optional(),
  /** Who pays; defaults to "self". */
  source: z.enum(PLAN_SOURCES).optional(),
});

export const planUserIdSchema = z.object({
  userId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid user id.'),
});

export type PlanSetInput = z.infer<typeof planSetSchema>;
