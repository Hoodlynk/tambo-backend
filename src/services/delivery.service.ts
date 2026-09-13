import type { IDevice } from '../models/device.model';
import PackDelivery from '../models/packDelivery.model';
import type { DeliveryChannel, DeliveryKind } from '../models/packDelivery.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import * as buddyService from './buddy.service';
import { lastKnownLocation, mapsLink } from './evidenceLocation';
import * as familiarLocationService from './familiarLocation.service';
import type { MailMessage } from './mailer';
import * as notifier from './notifier.service';
import type { PushContent } from './notifier.service';
import { buildPack } from './pack.service';
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

const claimAndSend = async (
  episode: ITheftEpisode,
  kind: DeliveryKind,
  recipient: string,
  message: MailMessage,
): Promise<boolean> => {
  if (!(await claim(episode, kind, recipient, 'email'))) return false;
  // fire-and-forget, the house pattern: provider latency or outage must not
  // block the request that triggered the alert
  notifier.sendEmail(message);
  return true;
};

/**
 * One push first-alert per HUMAN per episode: the claim is per user id
 * (`push:<userId>`), and the send multicasts to all their devices. Users with
 * no registered tokens are skipped without claiming, so a token registered
 * later can still receive a pack nudge for a different episode - but a claim,
 * once made, is final for this episode like the email one.
 */
const claimAndPush = async (
  episode: ITheftEpisode,
  kind: DeliveryKind,
  userId: string,
  content: PushContent,
): Promise<boolean> => {
  const tokens = await pushTokenService.activeTokensForUser(userId);
  if (tokens.length === 0) return false; // email-only recipient
  if (!(await claim(episode, kind, `push:${userId}`, 'push'))) return false;
  notifier.sendPush(userId, content);
  return true;
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
  const owner = await User.findById(episode.user);
  if (!owner) return;

  const trigger =
    episode.openedBy === 'device'
      ? 'was flagged as possibly stolen after repeated failed unlock attempts'
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
  const essentials = [
    `Device: ${device.make} ${device.deviceModel} ("${device.name}")`,
    `IMEI${device.imeis.length > 1 ? 's' : ''}: ${device.imeis.join(', ')}`,
    known
      ? `Last known location: ${known.location.lat}, ${known.location.lng}` +
        (known.location.accuracyM ? ` (±${known.location.accuracyM}m)` : '') +
        (familiar
          ? ` - near familiar location "${familiar.label}" (~${familiar.distanceM}m from its centre)`
          : '') +
        ` at ${known.at.toISOString()} - ${mapsLink(known.location)}`
      : 'Last known location: not yet reported.',
  ].join('\n');

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

  // push, claimed per human independently of email; lock-screen-safe payload
  const push: PushContent = {
    title: subject,
    body: `"${device.name}" ${trigger} at ${when}. Open Tambo for the details.`,
    data: { type: 'first_alert', episodeId: episode._id.toString() },
  };
  await claimAndPush(episode, 'first_alert', episode.user.toString(), push);
  for (const buddyId of await buddyService.activeBuddyUserIds(
    episode.user.toString(),
  )) {
    await claimAndPush(episode, 'first_alert', buddyId, push);
  }
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
  // and the pack stays fetchable in-app + attached to the email)
  const nudge: PushContent = {
    title: `Evidence pack ready: ${pack.device.name}`,
    body: 'The signed evidence pack was emailed and is available in the app.',
    data: { type: 'full_pack', episodeId },
  };
  const pushRecipients = [
    userId,
    ...(await buddyService.activeBuddyUserIds(userId)),
  ];
  for (const recipientId of pushRecipients) {
    const tokens = await pushTokenService.activeTokensForUser(recipientId);
    if (tokens.length === 0) continue;
    await PackDelivery.create({
      user: userId,
      episode: episodeId,
      kind: 'full_pack',
      recipient: `push:${recipientId}`,
      channel: 'push',
      sentAt: new Date(),
    });
    notifier.sendPush(recipientId, nudge);
  }

  return { recipients };
};
