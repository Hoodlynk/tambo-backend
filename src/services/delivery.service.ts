import type { IDevice } from '../models/device.model';
import PackDelivery from '../models/packDelivery.model';
import type {
  DeliveryChannel,
  DeliveryKind,
} from '../models/packDelivery.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import * as buddyService from './buddy.service';
import { entitlementsFor } from './entitlements';
import { lastKnownLocation, mapsLink } from './evidenceLocation';
import * as familiarLocationService from './familiarLocation.service';
import type { MailMessage } from './mailer';
import * as notifier from './notifier.service';
import * as partnerService from './partner.service';
import type { PushContent } from './notifier.service';
import { buildPack, getOwnedEpisode } from './pack.service';
import { logger } from '../utils/logger';
import { renderPackPdf } from './pack.pdf';
import * as pushTokenService from './pushToken.service';

/**
 * Alert delivery: email (the backbone channel - Evidence doc S5.1) plus push
 * to every registered device of each recipient who is a Tambo user. WhatsApp
 * is a later, opt-in-gated addition; nothing here assumes it.
 *
 * Recipients: the owner, plus every ACCEPTED buddy. A buddy is a Tambo user who
 * accepted the invitation in-app - that acceptance is the consent, so pending,
 * declined and revoked buddies receive nothing on any channel.
 *
 * Push payloads stay minimal (device name + deep link) - notifications land on
 * lock screens, so IMEIs and locations travel by email and in-app only.
 */

// Only ACCEPTED buddies receive alerts (their in-app accept is the consent);
// declined/revoked/pending get nothing.
const eligibleContactEmails = (userId: string): Promise<string[]> =>
  buddyService.activeBuddyEmails(userId);

/**
 * Records the send BEFORE dispatching. The partial unique index makes the
 * insert an atomic claim for first_alerts: whoever loses the race (owner
 * mark-stolen vs device threshold, converging on one episode) skips the send,
 * so nobody is ever double-alerted. Channels claim independently - a sent
 * email never suppresses the push, or vice versa.
 */
const claim = async (
  episode: ITheftEpisode,
  kind: DeliveryKind,
  recipient: string,
  channel: DeliveryChannel,
): Promise<boolean> => {
  try {
    await PackDelivery.create({
      user: episode.user,
      episode: episode._id,
      kind,
      recipient,
      channel,
      sentAt: new Date(),
    });
    return true;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false; // already alerted
    throw error;
  }
};

/** allSettled keeps the fan-out alive past one failure - but a failed CLAIM
 *  (a DB error, not a dedupe loss) must never vanish without a trace. */
const logRejected = (
  settled: PromiseSettledResult<unknown>[],
  message: string,
): void => {
  for (const result of settled) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, message);
    }
  }
};

const claimAndSend = async (
  episode: ITheftEpisode,
  kind: DeliveryKind,
  recipient: string,
  message: MailMessage,
): Promise<boolean> => {
  if (!(await claim(episode, kind, recipient, 'email'))) return false;
  // fire-and-forget, the house pattern: provider latency or outage must not
  // block the request that triggered the alert
  notifier.sendEmail(message, kind);
  return true;
};

/**
 * One push per HUMAN per episode per kind: the claim is per user id, and the
 * dispatch multicasts to the SAME token set the claim was decided on - a
 * token pruned or reassigned between "check" and "send" cannot burn a claim
 * with nothing delivered. Users with no registered tokens are skipped
 * without claiming (email-only recipients); a claim, once made, is final for
 * this episode like the email one. (full_pack rows are audit, not deduped -
 * claim() always succeeds for them.)
 */
const claimAndPush = async (
  episode: ITheftEpisode,
  kind: DeliveryKind,
  userId: string,
  content: PushContent,
): Promise<boolean> => {
  // never the stolen phone itself: a lock-screen "may be stolen" banner
  // tells the thief exactly when to pull the SIM
  const tokens = await pushTokenService.activeTokensForUser(userId, {
    excludeDevice: episode.device,
  });
  if (tokens.length === 0) return false; // email-only recipient
  if (!(await claim(episode, kind, userId, 'push'))) return false;
  notifier.sendPushToTokens(userId, tokens, content);
  return true;
};

/** IMEIs, make/model and last known location: what police and operators need. */
const deviceEssentials = (
  device: IDevice,
  known: Awaited<ReturnType<typeof lastKnownLocation>>,
  familiarNote = '',
): string =>
  [
    `Device: ${device.make} ${device.deviceModel} ("${device.name}")`,
    `IMEI${device.imeis.length > 1 ? 's' : ''}: ${device.imeis.join(', ') || 'not provided by the owner'}`,
    known
      ? `Last known location: ${known.location.lat}, ${known.location.lng}` +
        (known.location.accuracyM ? ` (±${known.location.accuracyM}m)` : '') +
        familiarNote +
        ` at ${known.at.toISOString()} - ${mapsLink(known.location)}`
      : 'Last known location: not yet reported.',
  ].join('\n');

/**
 * An episode on a partner phone nobody has linked yet (B4): the partner's
 * alert recipients are the only people who can act, so they get the first
 * alert, deduped per address like the owner's. Email only - recipients are
 * mailboxes, not Tambo users. With no recipients configured nobody is told,
 * which is logged so the gap is visible.
 */
const sendPartnerFirstAlert = async (
  episode: ITheftEpisode,
  device: IDevice,
): Promise<void> => {
  const fleet = device.partner
    ? await partnerService.alertRecipientsFor(device.partner)
    : null;
  if (!fleet || fleet.recipients.length === 0) {
    logger.warn(
      { episode: episode._id.toString(), device: device._id.toString() },
      'ownerless episode opened with no partner alert recipients',
    );
    return;
  }

  const subject = `Tambo alert: unlinked ${fleet.partner.name} device may be stolen`;
  const text = [
    `At ${episode.openedAt.toISOString()}, a ${fleet.partner.name} device ` +
      'that has not been linked to an owner yet was flagged as possibly ' +
      'stolen after repeated failed unlock attempts.',
    '',
    deviceEssentials(device, await lastKnownLocation(device._id)),
    device.serial ? `Serial: ${device.serial}` : '',
    `Tambo device id: ${device._id.toString()}`,
    '',
    'The phone keeps uploading evidence. It cannot be linked to an account ' +
      'while the episode is open; if this is a false alarm, resolve it with ' +
      `POST /api/v1/partner/devices/${device._id.toString()}/mark-recovered.`,
  ]
    .filter((line, index, lines) => line !== '' || lines[index - 1] !== '')
    .join('\n');

  for (const recipient of fleet.recipients) {
    await claimAndSend(episode, 'first_alert', recipient.email, {
      to: recipient.email,
      subject,
      text: recipient.name ? `Hi ${recipient.name},\n\n${text}` : text,
    });
  }
};

/**
 * The tiny first alert (Evidence doc S2.3): the owner learns NOW; the full
 * evidence pack follows as uploads land. Called from episode.service the
 * moment an episode opens, whatever opened it.
 */
export const sendFirstAlert = async (
  episode: ITheftEpisode,
  device: IDevice,
): Promise<void> => {
  if (!episode.user) {
    await sendPartnerFirstAlert(episode, device);
    return;
  }
  const owner = await User.findById(episode.user);
  if (!owner) return;

  const reporter =
    episode.openedBy === 'buddy' && episode.reportedBy
      ? await User.findById(episode.reportedBy)
      : null;

  const trigger =
    episode.openedBy === 'device'
      ? 'was flagged as possibly stolen after repeated failed unlock attempts'
      : episode.openedBy === 'buddy'
        ? `was reported as possibly stolen by ${reporter?.name ?? 'one of their buddies'} (a Tambo buddy)`
        : `was marked as possibly stolen by ${owner.name}`;

  const when = episode.openedAt.toISOString();
  const subject = `Tambo alert: ${device.name} may be stolen`;

  // the essentials the police report and the operator blacklist request need:
  // IMEIs, make/model, and where the attempts happened (when the device
  // managed to report a location before/while going dark)
  const known = await lastKnownLocation(device._id);
  // familiar places are interpretation only (F3): they change this sentence,
  // never whether the alert fires
  const familiar = known
    ? familiarLocationService.matchFamiliar(
        await familiarLocationService.list(episode.user.toString()),
        known.location,
      )
    : null;
  const essentials = deviceEssentials(
    device,
    known,
    familiar
      ? ` - near familiar location "${familiar.label}" (~${familiar.distanceM}m from its centre)`
      : '',
  );

  const bodyFor = (recipientName: string, isOwner: boolean): string =>
    [
      `Hi ${recipientName},`,
      '',
      `At ${when}, ${isOwner ? 'your' : `${owner.name}'s`} phone ` +
        `"${device.name}" (${device.make} ${device.deviceModel}) ${trigger}.`,
      '',
      essentials,
      '',
      isOwner
        ? 'Tambo is collecting evidence now. You will receive the full evidence ' +
          'pack as it uploads; you can also fetch it any time from the app.'
        : `You are receiving this because ${owner.name} nominated you as their ` +
          'buddy. The evidence pack will follow so you can help them act quickly.',
      '',
      'First steps: block the SIM with the operator, and report at the nearest ' +
        'police station to get an OB number.',
    ].join('\n');

  if (owner.email) {
    await claimAndSend(episode, 'first_alert', owner.email, {
      to: owner.email,
      subject,
      text: bodyFor(owner.name, true),
    });
  }

  for (const email of await eligibleContactEmails(episode.user.toString())) {
    await claimAndSend(episode, 'first_alert', email, {
      to: email,
      subject,
      text: bodyFor('there', false),
    });
  }

  // push, claimed per human independently of email; lock-screen-safe payload.
  // Real-time push alerts are a paid entitlement of the PROTECTED account
  // (the owner's subscription covers their buddies); email always goes out.
  if (!entitlementsFor(owner).pushAlerts) return;
  const push: PushContent = {
    title: subject,
    body: `"${device.name}" ${trigger} at ${when}. Open Tambo for the details.`,
    data: { type: 'first_alert', episodeId: episode._id.toString() },
  };
  // per-recipient claims are independent - fan out in parallel so alert
  // latency does not grow with the buddy count on the theft hot path
  const buddyIds = await buddyService.activeBuddyUserIds(
    episode.user.toString(),
  );
  const settled = await Promise.allSettled(
    [episode.user.toString(), ...buddyIds].map((userId) =>
      claimAndPush(episode, 'first_alert', userId, push),
    ),
  );
  logRejected(settled, 'first_alert push claim failed');
};

export interface PackSendResult {
  recipients: string[];
}

/**
 * Builds the pack, renders the PDF, and emails it to the owner and every
 * eligible buddy. Re-sending is legitimate (more evidence may have
 * landed), so full_pack sends are recorded for audit rather than deduped.
 */
export const sendPack = async (
  userId: string,
  episodeId: string,
): Promise<PackSendResult> => {
  const pack = await buildPack(userId, episodeId);
  const pdf = await renderPackPdf(pack);

  const owner = await User.findById(userId);
  const recipients = [
    ...(owner?.email ? [owner.email] : []),
    ...(await eligibleContactEmails(userId)),
  ];

  const attachment = {
    filename: `tambo-evidence-${pack.episode.id}.pdf`,
    content: pdf.toString('base64'),
    contentType: 'application/pdf',
  };

  for (const recipient of recipients) {
    await PackDelivery.create({
      user: userId,
      episode: episodeId,
      kind: 'full_pack',
      recipient,
      channel: 'email',
      sentAt: new Date(),
    });

    notifier.sendEmail({
      to: recipient,
      subject: `Tambo evidence pack: ${pack.device.name}`,
      text: [
        'Attached is the evidence pack for the theft episode opened at ' +
          `${pack.episode.openedAt}.`,
        '',
        'It contains the incident timeline, failed unlock attempts, the ' +
          'location trail, device identity (including IMEIs), and a signed ' +
          'integrity manifest - shaped for a police report, an eCitizen ' +
          'abstract application, and an insurance claim.',
        '',
        'The action checklist inside lists the next steps.',
      ].join('\n'),
      attachments: [attachment],
    });
  }

  // push is a NUDGE with a deep link, never the PDF (FCM payloads are ~4KB,
  // and the pack stays fetchable in-app + attached to the email). Gated on
  // the protected account's plan, like the first alert.
  if (!owner || !entitlementsFor(owner).pushAlerts) return { recipients };
  const nudge: PushContent = {
    title: `Evidence pack ready: ${pack.device.name}`,
    body: 'The signed evidence pack was emailed and is available in the app.',
    data: { type: 'full_pack', episodeId },
  };
  const episode = await getOwnedEpisode(userId, episodeId);
  const pushRecipients = [
    userId,
    ...(await buddyService.activeBuddyUserIds(userId)),
  ];
  // same mechanism as the first alert (claim, then dispatch to the same
  // token set); full_pack claims are audit rows, never deduped, and the
  // per-recipient sends are independent - fan out in parallel
  const settled = await Promise.allSettled(
    pushRecipients.map((recipientId) =>
      claimAndPush(episode, 'full_pack', recipientId, nudge),
    ),
  );
  logRejected(settled, 'full_pack push claim failed');

  return { recipients };
};
