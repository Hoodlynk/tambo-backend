import User from '../models/user.model';
import type { PlanSource, UserPlan } from '../models/user.model';
import { AppError } from '../utils/appError';
import * as audit from './audit.service';
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
  /** "partner" = paid for by a white-label partner; store billing leaves it alone. */
  source: PlanSource;
  entitlements: Entitlements;
}

const toView = (user: {
  plan: UserPlan;
  planExpiresAt?: Date;
  planSource?: PlanSource;
}): PlanView => ({
  plan: user.plan,
  effectivePlan: effectivePlan(user),
  expiresAt: user.planExpiresAt?.toISOString() ?? null,
  source: user.planSource ?? 'self',
  entitlements: entitlementsFor(user),
});

export const getForUser = async (userId: string): Promise<PlanView> => {
  const user = await User.findById(userId);
  if (!user) throw AppError.unauthorized();
  return toView(user);
};

/**
 * `source` records who pays. The Play Billing webhook (roadmap 3b) must skip
 * an account whose plan source is "partner" while that plan is in force:
 * a partner-paid seat is not the store's to downgrade.
 */
export const setPlan = async (
  userId: string,
  plan: UserPlan,
  expiresAt?: Date,
  source: PlanSource = 'self',
): Promise<PlanView> => {
  // a paid plan may carry an expiry (billing renewals bump it); free never does
  const update =
    plan !== 'free' && expiresAt
      ? { $set: { plan, planSource: source, planExpiresAt: expiresAt } }
      : { $set: { plan, planSource: source }, $unset: { planExpiresAt: 1 } };
  const user = await User.findByIdAndUpdate(userId, update, { new: true });
  if (!user) throw AppError.notFound('User not found.', 'user_not_found');
  // billing disputes ask "who set this plan, when" - the ledger answers
  audit.record(userId, 'plan_changed', {
    meta: { plan, source, expiresAt: expiresAt?.toISOString() ?? null },
  });
  return toView(user);
};
