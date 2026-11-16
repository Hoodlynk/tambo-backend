import { mailer } from './mailer';
import type { MailMessage } from './mailer';
import { pusher } from './push';
import * as pushTokenService from './pushToken.service';
import { logger } from '../utils/logger';

/**
 * "Notify this user" - the channel fan-out in one place. Email goes to an
 * address; push multicasts to every device token the user has registered,
 * then prunes the tokens the provider reports dead. SMS/WhatsApp later are
 * one more channel here, not new logic at every call site.
 *
 * Both channels keep the house fire-and-forget rule: provider latency or
 * outage must never block (or time-fingerprint) the request that triggered
 * the notification. Callers that need "was it claimed?" semantics do their
 * claiming BEFORE calling this (see delivery.service).
 */

export interface PushContent {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export const sendEmail = (message: MailMessage, kind = 'email'): void => {
  void mailer.send(message).catch((error) => {
    logger.error({ err: error, to: message.to, kind }, 'failed to send email');
  });
};

/**
 * Fire-and-forget multicast to a KNOWN token set; dead tokens pruned after.
 * Callers that first check "does this user have tokens?" (to decide whether
 * to claim a delivery) pass the same set here, so the claim and the dispatch
 * can never disagree about which devices existed.
 */
export const sendPushToTokens = (
  userId: string,
  tokens: string[],
  content: PushContent,
): void => {
  if (tokens.length === 0) return;
  void (async () => {
    const result = await pusher.send({ tokens, ...content });
    await pushTokenService.pruneTokens(result.invalidTokens);
  })().catch((error) => {
    logger.error({ err: error, userId }, 'failed to push-notify user');
  });
};

/** Convenience for callers with no prior token check. */
export const sendPush = (userId: string, content: PushContent): void => {
  void pushTokenService
    .activeTokensForUser(userId)
    .then((tokens) => sendPushToTokens(userId, tokens, content))
    .catch((error) => {
      logger.error({ err: error, userId }, 'failed to push-notify user');
    });
};

/**
 * Silent wake-up for one enrolled device's installs (B2 remote commands).
 * Fire-and-forget like every channel here; a phone with no device-scoped
 * token still gets the command on its next poll or ingest reply.
 */
export const wakeDevice = (
  deviceId: string,
  data: Record<string, string>,
): void => {
  void (async () => {
    const tokens = await pushTokenService.activeTokensForDevice(deviceId);
    if (tokens.length === 0) return;
    const result = await pusher.sendData({ tokens, data });
    await pushTokenService.pruneTokens(result.invalidTokens);
  })().catch((error) => {
    logger.error({ err: error, deviceId }, 'failed to wake device');
  });
};
