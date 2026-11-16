import type { IUser, UserPlan } from '../models/user.model';

/**
 * THE lookup for what a plan unlocks (docs/plans-scoping.md). Feature services
 * ask this module - never `user.plan` directly - so the entitlement matrix is
 * reviewable in one screen and a plan change is one edit.
 *
 * Two rules the matrix must never violate:
 * - Evidence is NEVER refused because of a plan. During a theft the backend
 *   takes everything the phone manages to send; entitlements shape reads and
 *   client cadence advice only.
 * - "Unlimited" history is still bounded by evidence retention (90d routine /
 *   365d episode) - a safety/privacy policy, not a plan perk.
 */

export interface Entitlements {
  /** Devices the account may enrol. */
  maxDevices: number;
  /** How far back activity reads reach; null = retention-bounded only. */
  historyDays: number | null;
  /** Advisory TRAIL_POINT cadence returned to the device during an episode. */
  trailCadenceSeconds: number;
  /** Real-time intruder alerts over push (email always works). */
  pushAlerts: boolean;
  /**
   * Advisory camera-burst policy returned to the device during an episode
   * (F4). Advice on how much to capture, never a cap on what is accepted.
   */
  snapshotPolicy: SnapshotPolicy;
}

export interface SnapshotPolicy {
  /** Frames to take from each camera per burst. */
  framesPerCamera: number;
  /** Seconds between frames of one burst. */
  intervalSeconds: number;
  /** Bursts the device should bother sending for one episode. */
  maxBurstsPerEpisode: number;
}

const FREE_SNAPSHOTS: SnapshotPolicy = {
  framesPerCamera: 3,
  intervalSeconds: 2,
  maxBurstsPerEpisode: 5,
};
const PAID_SNAPSHOTS: SnapshotPolicy = {
  framesPerCamera: 3,
  intervalSeconds: 2,
  maxBurstsPerEpisode: 20,
};

const MATRIX: Record<UserPlan, Entitlements> = {
  free: {
    maxDevices: 1,
    historyDays: 7,
    trailCadenceSeconds: 300,
    pushAlerts: false,
    snapshotPolicy: FREE_SNAPSHOTS,
  },
  pro: {
    maxDevices: 1,
    historyDays: null,
    trailCadenceSeconds: 60,
    pushAlerts: true,
    snapshotPolicy: PAID_SNAPSHOTS,
  },
  family: {
    maxDevices: 5,
    historyDays: null,
    trailCadenceSeconds: 60,
    pushAlerts: true,
    snapshotPolicy: PAID_SNAPSHOTS,
  },
};

/** The plan actually in force: a lapsed paid plan reads as free. */
export const effectivePlan = (
  user: Pick<IUser, 'plan' | 'planExpiresAt'>,
): UserPlan =>
  user.plan !== 'free' && user.planExpiresAt && user.planExpiresAt <= new Date()
    ? 'free'
    : user.plan;

export const entitlementsFor = (
  user: Pick<IUser, 'plan' | 'planExpiresAt'>,
): Entitlements => MATRIX[effectivePlan(user)];
