export interface PushMessage {
  /** FCM registration tokens - one multicast, all of a user's devices. */
  tokens: string[];
  title: string;
  body: string;
  /**
   * Deep-link/data payload the client app routes on. Keep it small and never
   * put IMEIs or locations here: push payloads surface on lock screens.
   */
  data?: Record<string, string>;
}

export interface PushResult {
  /**
   * Tokens the provider reports as dead (uninstalled app, rotated token).
   * The caller prunes these rows - error-driven cleanup, no cron.
   */
  invalidTokens: string[];
}

/**
 * The seam between "notify this user's devices" and "a vendor delivered it" -
 * the push twin of Mailer. One provider today (FCM covers Android, web push,
 * and the APNs relay for iOS); a second means one new file and one line in
 * index.ts.
 */
export interface Pusher {
  send(message: PushMessage): Promise<PushResult>;
}
