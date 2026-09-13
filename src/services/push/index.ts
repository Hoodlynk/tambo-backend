import config from '../../config/config';
import { consolePusher } from './console.push';
import { fcmPusher } from './fcm.push';
import { noopPusher } from './noop.push';
import type { Pusher } from './push.interface';

/**
 * config.push.driver is validated at boot (unknown PUSH_DRIVER, or fcm
 * without credentials, refuses to start) - mirror of the mailer seam.
 */
const drivers: Record<typeof config.push.driver, Pusher> = {
  console: consolePusher,
  noop: noopPusher,
  fcm: fcmPusher,
};

export const pusher: Pusher = drivers[config.push.driver];
export type { Pusher, PushMessage, PushResult } from './push.interface';
