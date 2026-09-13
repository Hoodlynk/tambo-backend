import User from '../models/user.model';
import type { UserPlan } from '../models/user.model';
import { AppError } from '../utils/appError';
import { effectivePlan, entitlementsFor } from './entitlements';
import type { Entitlements } from './entitlements';

/**
 * The plan surface. Reading is every client's Settings screen; WRITING is an
 * admin/manual act until the Play Billing webhook lands (roadmap 3b), at which
 * point the webhook calls the same setPlan and the admin route becomes the
 * support-desk escape hatch.
 */

export interface PlanView {
  plan: UserPlan;
  /** What is actually in force right now (a lapsed paid plan reads as free). */
  effectivePlan: UserPlan;
  expiresAt: string | null;
  entitlements: Entitlements;
}

const toView = (user: { plan: UserPlan; planExpiresAt?: Date }): PlanView => ({
  plan: user.plan,
  effectivePlan: effectivePlan(user),
  expiresAt: user.planExpiresAt?.toISOString() ?? null,
  entitlements: entitlementsFor(user),
});

export const getForUser = async (userId: string): Promise<PlanView> => {
  const user = await User.findById(userId);
  if (!user) throw AppError.unauthorized();
  return toView(user);
};

export const setPlan = async (
  userId: string,
  plan: UserPlan,
  expiresAt?: Date,
): Promise<PlanView> => {
  // a paid plan may carry an expiry (billing renewals bump it); free never does
  const update =
    plan !== 'free' && expiresAt
      ? { $set: { plan, planExpiresAt: expiresAt } }
      : { $set: { plan }, $unset: { planExpiresAt: 1 } };
  const user = await User.findByIdAndUpdate(userId, update, { new: true });
  if (!user) throw AppError.notFound('User not found.', 'user_not_found');
  return toView(user);
};
