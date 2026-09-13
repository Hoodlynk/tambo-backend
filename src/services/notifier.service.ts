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

export const sendEmail = (message: MailMessage): void => {
  void mailer.send(message).catch((error) => {
    logger.error({ err: error, to: message.to }, 'failed to send email');
  });
};

/** Fire-and-forget multicast to all of a user's devices; dead tokens pruned. */
export const sendPush = (userId: string, content: PushContent): void => {
  void (async () => {
    const tokens = await pushTokenService.activeTokensForUser(userId);
    if (tokens.length === 0) return;
    const result = await pusher.send({ tokens, ...content });
    await pushTokenService.pruneTokens(result.invalidTokens);
  })().catch((error) => {
    logger.error({ err: error, userId }, 'failed to push-notify user');
  });
};
