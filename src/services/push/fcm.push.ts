import type { Pusher, PushMessage, PushResult } from './push.interface';
import config from '../../config/config';

/**
 * Firebase Cloud Messaging: one provider for Android (native), the PWA (web
 * push), and iOS (FCM relays to APNs). firebase-admin is imported lazily so
 * that merely having the driver on disk costs nothing when another driver is
 * configured (tests run noop; the SDK is heavyweight).
 */

/** FCM error codes that mean "this token will never work again - delete it". */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

type FirebaseAdmin = typeof import('firebase-admin');

let admin: FirebaseAdmin | null = null;

const firebase = (): FirebaseAdmin => {
  if (admin) return admin;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  admin = require('firebase-admin') as FirebaseAdmin;
  const serviceAccount = JSON.parse(
    Buffer.from(config.push.fcmServiceAccountJson, 'base64').toString('utf8'),
  ) as object;
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  return admin;
};

class FcmPusher implements Pusher {
  async send(message: PushMessage): Promise<PushResult> {
    if (message.tokens.length === 0) return { invalidTokens: [] };

    const response = await firebase().messaging().sendEachForMulticast({
      tokens: message.tokens,
      notification: { title: message.title, body: message.body },
      ...(message.data ? { data: message.data } : {}),
    });

    const invalidTokens: string[] = [];
    response.responses.forEach((result, index) => {
      const code = result.error?.code;
      const token = message.tokens[index];
      if (code && token && DEAD_TOKEN_CODES.has(code)) {
        invalidTokens.push(token);
      } else if (result.error) {
        // transient (quota, unavailable): keep the token, log the failure
        console.error(`FCM send failed (${code ?? 'unknown'}):`, result.error);
      }
    });

    return { invalidTokens };
  }
}

export const fcmPusher = new FcmPusher();
