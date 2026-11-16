import config from '../config/config';
import AlertActionToken from '../models/alertActionToken.model';
import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/tokens';
import * as episodeService from './episode.service';
import { logger } from '../utils/logger';
import * as notifier from './notifier.service';

/**
 * The "went quiet" watchdog - the answer to a thief who flips airplane mode
 * from the lock screen or powers the phone off. Neither can be blocked from
 * an ordinary app, but both make the phone STOP checking in, and silence is
 * the one signal a thief cannot suppress.
 *
 * Two tiers, both OWNER-ONLY (silence alone is too weak to wake the buddies;
 * the owner confirms with one tap, and THAT alerts them):
 *
 * - after_suspicion: a failed unlock or a boot left on the lock screen that
 *   no successful unlock has cleared, then quietAfterMinutes of silence.
 * - silent: silentAfterHours with no contact at all - the only coverage for
 *   a thief who goes offline before trying a single PIN.
 *
 * At most one alert per silence: quietAlertedAt is claimed atomically and
 * only re-arms once the device is heard from again.
 */

export type QuietReason = 'after_suspicion' | 'silent';

const minutesAgo = (now: Date, minutes: number): Date =>
  new Date(now.getTime() - minutes * 60 * 1000);

const actionLinkUrl = (token: string): string =>
  `${config.publicApiUrl}/api/v1/alert-actions/${token}`;

const issueActionLink = async (device: IDevice, now: Date): Promise<string> => {
  const token = generateOpaqueToken();
  await AlertActionToken.create({
    user: device.user,
    device: device._id,
    tokenHash: hashOpaqueToken(token),
    expiresAt: new Date(
      now.getTime() + config.watchdog.actionLinkTtlHours * 60 * 60 * 1000,
    ),
  });
  return actionLinkUrl(token);
};

const sendQuietAlert = async (
  device: IDevice,
  reason: QuietReason,
  now: Date,
): Promise<void> => {
  const owner = await User.findById(device.user);
  if (!owner?.email) return;

  const link = await issueActionLink(device, now);
  const lastSeen = device.lastSeenAt?.toISOString() ?? 'unknown';
  const phone = `"${device.name}" (${device.make} ${device.deviceModel})`;

  const subject =
    reason === 'after_suspicion'
      ? `Tambo: ${device.name} went offline after a failed unlock or restart`
      : `Tambo: ${device.name} has not checked in for ${config.watchdog.silentAfterHours} hours`;

  const what =
    reason === 'after_suspicion'
      ? `Your phone ${phone} saw a failed unlock attempt or a restart left on ` +
        `the lock screen, and has not checked in with Tambo since ${lastSeen}.`
      : `Your phone ${phone} has not checked in with Tambo since ${lastSeen}.`;

  const text = [
    `Hi ${owner.name},`,
    '',
    what,
    '',
    'That is what a thief switching on airplane mode or powering the phone ' +
      'off looks like - but it can also be a flat battery or no signal.',
    '',
    'If your phone is NOT with you, mark it stolen now. Tambo will alert ' +
      'your buddies and start your evidence pack:',
    '',
    link,
    '',
    `The link works once, for ${config.watchdog.actionLinkTtlHours} hours.`,
    '',
    'If your phone is with you, just unlock it - Tambo clears this on its own.',
  ].join('\n');

  notifier.sendEmail({ to: owner.email, subject, text }, 'quiet alert');
};

/**
 * One pass of the watchdog. Returns how many owners were alerted. `now` is
 * injectable so tests can move time instead of waiting for it.
 */
export const sweepQuietDevices = async (now = new Date()): Promise<number> => {
  const { quietAfterMinutes, suspicionLookbackHours, silentAfterHours } =
    config.watchdog;
  const suspicionSince = minutesAgo(now, suspicionLookbackHours * 60);

  const tiers: Record<string, unknown>[] = [
    { suspiciousAt: { $gte: suspicionSince } },
  ];
  if (silentAfterHours > 0) {
    tiers.push({
      lastSeenAt: { $lte: minutesAgo(now, silentAfterHours * 60) },
    });
  }

  const candidates = await Device.find({
    // a stolen device already has an episode and alerts; only watch the rest
    status: 'active',
    // the alert goes to the owner; a partner phone nobody has linked yet has
    // none, and its silence on a shop shelf means nothing
    user: { $exists: true },
    // no token = nothing can report from it (signed out, revoked): its
    // silence means nothing
    ingestTokenHash: { $exists: true },
    lastSeenAt: { $lte: minutesAgo(now, quietAfterMinutes) },
    $or: tiers,
  })
    .select('_id lastSeenAt')
    .limit(500);

  let alerted = 0;
  for (const candidate of candidates) {
    // The claim: still silent since we looked (lastSeenAt unchanged), and not
    // already alerted for THIS silence. Concurrent sweeps (several instances)
    // race on this update; exactly one wins.
    const claimed = await Device.findOneAndUpdate(
      {
        _id: candidate._id,
        status: 'active',
        lastSeenAt: candidate.lastSeenAt,
        $or: [
          { quietAlertedAt: { $exists: false } },
          { $expr: { $lt: ['$quietAlertedAt', '$lastSeenAt'] } },
        ],
      },
      { $set: { quietAlertedAt: now } },
      { new: true },
    );
    if (!claimed) continue;

    const reason: QuietReason =
      claimed.suspiciousAt && claimed.suspiciousAt >= suspicionSince
        ? 'after_suspicion'
        : 'silent';

    try {
      await sendQuietAlert(claimed, reason, now);
      alerted += 1;
    } catch (error) {
      // one owner's failure (e.g. a deleted account) must not stall the rest
      logger.error(
        { err: error, deviceId: claimed.id },
        'quiet alert failed for device',
      );
    }
  }
  return alerted;
};

// --- the one-tap link -------------------------------------------------------

export interface ActionLinkTarget {
  deviceName: string;
  lastSeenAt: Date | null;
}

const liveTokenFilter = (token: string, now: Date) => ({
  tokenHash: hashOpaqueToken(token),
  usedAt: { $exists: false },
  expiresAt: { $gt: now },
});

/** What the confirmation page shows; null when the link is dead. Read-only. */
export const describeActionLink = async (
  token: string,
): Promise<ActionLinkTarget | null> => {
  const record = await AlertActionToken.findOne(
    liveTokenFilter(token, new Date()),
  );
  if (!record) return null;
  const device = await Device.findById(record.device);
  if (!device) return null;
  return { deviceName: device.name, lastSeenAt: device.lastSeenAt ?? null };
};

/**
 * Spends the link and marks the device stolen - the same episode path as the
 * owner's in-app mark-stolen, so buddies get the first alert. Atomic claim:
 * a double-submit opens one episode and reports the second as already done.
 */
export const useActionLink = async (
  token: string,
): Promise<{ episode: ITheftEpisode; created: boolean } | null> => {
  const now = new Date();
  const record = await AlertActionToken.findOneAndUpdate(
    liveTokenFilter(token, now),
    { $set: { usedAt: now } },
    { new: true },
  );
  if (!record) return null;

  const device = await Device.findById(record.device);
  if (!device) return null;

  return episodeService.openEpisode(
    device,
    'owner',
    'Reported from the "went offline" alert email.',
  );
};
