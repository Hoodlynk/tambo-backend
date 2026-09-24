import type { IDevice } from '../models/device.model';
import PackDelivery from '../models/packDelivery.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import * as buddyService from './buddy.service';
import { mailer } from './mailer';
import type { MailMessage } from './mailer';
import { buildPack } from './pack.service';
import { renderPackPdf } from './pack.pdf';

/**
 * Email delivery (the backbone channel - Evidence doc S5.1). WhatsApp is a
 * later, opt-in-gated addition; nothing here assumes it.
 *
 * Recipients: the owner, plus every ACCEPTED buddy. A buddy is a Tambo user who
 * accepted the invitation in-app - that acceptance is the consent, so pending,
 * declined and revoked buddies receive nothing on any channel.
 */

// Only ACCEPTED buddies receive alerts (their in-app accept is the consent);
// declined/revoked/pending get nothing.
const eligibleContactEmails = (userId: string): Promise<string[]> =>
  buddyService.activeBuddyEmails(userId);

/**
 * Records the send BEFORE dispatching. The partial unique index makes the
 * insert an atomic claim for first_alerts: whoever loses the race (owner
 * mark-stolen vs device threshold, converging on one episode) skips the send,
 * so nobody is ever double-alerted.
 */
const claimAndSend = async (
  episode: ITheftEpisode,
  kind: 'first_alert' | 'full_pack',
  recipient: string,
  message: MailMessage,
): Promise<boolean> => {
  try {
    await PackDelivery.create({
      user: episode.user,
      episode: episode._id,
      kind,
      recipient,
      sentAt: new Date(),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) return false; // already alerted
    throw error;
  }

  // fire-and-forget, the house mail pattern: provider latency or outage must
  // not block the request that triggered the alert
  void mailer.send(message).catch((error) => {
    console.error(`Failed to send ${kind} email to ${recipient}:`, error);
  });
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

  const reporter =
    episode.openedBy === 'buddy' && episode.reportedBy
      ? await User.findById(episode.reportedBy)
      : null;

  const trigger =
    episode.openedBy === 'device'
      ? 'repeated failed unlock attempts were detected on'
      : episode.openedBy === 'buddy'
        ? `${reporter?.name ?? 'one of their buddies'} (a Tambo buddy) reported`
        : 'the owner marked';

  const when = episode.openedAt.toISOString();
  const subject = `Tambo alert: ${device.name} may be stolen`;

  const bodyFor = (recipientName: string, isOwner: boolean): string =>
    [
      `Hi ${recipientName},`,
      '',
      `At ${when}, ${trigger} ${isOwner ? 'your' : `${owner.name}'s`} phone ` +
        `"${device.name}" (${device.make} ${device.deviceModel}) as possibly stolen.`,
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
      sentAt: new Date(),
    });

    void mailer
      .send({
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
      })
      .catch((error) => {
        console.error(`Failed to send full_pack email to ${recipient}:`, error);
      });
  }

  return { recipients };
};
