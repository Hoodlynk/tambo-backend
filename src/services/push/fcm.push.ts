import type {
  DataPushMessage,
  Pusher,
  PushMessage,
  PushResult,
} from './push.interface';
import config from '../../config/config';
import { logger } from '../../utils/logger';

/**
 * Firebase Cloud Messaging: one provider for Android (native), the PWA (web
 * push), and iOS (FCM relays to APNs). firebase-admin is imported lazily so
 * that merely having the driver on disk costs nothing when another driver is
 * configured (tests run noop; the SDK is heavyweight).
 */

/**
 * FCM error codes that mean "this TOKEN will never work again - delete it".
 * Deliberately NOT including 'messaging/invalid-argument': FCM also returns
 * that for a malformed MESSAGE, and a payload bug must never mass-delete
 * healthy registrations (that would silently disable theft alerts).
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

type FirebaseAdmin = typeof import('firebase-admin');

let admin: FirebaseAdmin | null = null;

const firebase = (): FirebaseAdmin => {
  if (admin) return admin;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require('firebase-admin') as FirebaseAdmin;
  const serviceAccount = JSON.parse(
    Buffer.from(config.push.fcmServiceAccountJson, 'base64').toString('utf8'),
  ) as object;
  loaded.initializeApp({
    credential: loaded.credential.cert(serviceAccount),
  });
  // cache only AFTER init succeeds: a failed first init (bad credential)
  // must be retried and keep surfacing its real cause, not a half-initialized
  // module and "default app does not exist" forever after
  admin = loaded;
  return admin;
};

type MulticastResponse = Awaited<
  ReturnType<ReturnType<FirebaseAdmin['messaging']>['sendEachForMulticast']>
>;

/** Splits a multicast response into dead tokens (returned) and logged failures. */
const deadTokens = (
  tokens: string[],
  response: MulticastResponse,
): string[] => {
  const invalidTokens: string[] = [];
  response.responses.forEach((result, index) => {
    const code = result.error?.code;
    const token = tokens[index];
    if (code && token && DEAD_TOKEN_CODES.has(code)) {
      invalidTokens.push(token);
    } else if (result.error) {
      // transient (quota, unavailable): keep the token, log the failure
      logger.error({ err: result.error, fcmCode: code }, 'FCM send failed');
    }
  });
  return invalidTokens;
};

class FcmPusher implements Pusher {
  async send(message: PushMessage): Promise<PushResult> {
    if (message.tokens.length === 0) return { invalidTokens: [] };

    const response = await firebase()
      .messaging()
      .sendEachForMulticast({
        tokens: message.tokens,
        notification: { title: message.title, body: message.body },
        ...(message.data ? { data: message.data } : {}),
      });

    return { invalidTokens: deadTokens(message.tokens, response) };
  }

  async sendData(message: DataPushMessage): Promise<PushResult> {
    if (message.tokens.length === 0) return { invalidTokens: [] };

    // high priority is what gets a data message through Android Doze to a
    // phone in a thief's pocket; on iOS it is a background (content-
    // available) push, which APNs requires to be sent at priority 5
    const response = await firebase()
      .messaging()
      .sendEachForMulticast({
        tokens: message.tokens,
        data: message.data,
        android: { priority: 'high' },
        apns: {
          headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
          payload: { aps: { contentAvailable: true } },
        },
      });

    return { invalidTokens: deadTokens(message.tokens, response) };
  }
}

export const fcmPusher = new FcmPusher();
