/**
 * Abuse budgets, kept in one place so they are reviewable at a glance and so
 * tests can tighten them to a couple of hits instead of simulating hundreds.
 */
export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

// `satisfies` (not a Record annotation) keeps the literal key type, so
// rateLimit({ name }) is checked at compile time - a typo'd rule name is a
// tsc error, not a runtime throw.
export const rateLimits = {
  /** Brute-force protection. Keyed on email + IP. */
  login: { limit: 5, windowSeconds: 15 * 60 },
  /** Signup spam. Keyed on IP. */
  register: { limit: 10, windowSeconds: 60 * 60 },
  /** Reset-email spam / mailbox flooding. Keyed on email + IP. */
  forgotPassword: { limit: 3, windowSeconds: 60 * 60 },
  /** Reset-token guessing. Keyed on IP. */
  resetPassword: { limit: 10, windowSeconds: 60 * 60 },
  /** Generous: a legitimate app refreshes on a timer. Keyed on IP. */
  refresh: { limit: 60, windowSeconds: 60 * 60 },
  /** Online code guessing. Keyed on IP; per-challenge attempts cap on top. */
  otpVerify: { limit: 15, windowSeconds: 15 * 60 },
  /** Mailbox flooding via resend. Keyed on IP; per-challenge cooldown on top. */
  otpResend: { limit: 6, windowSeconds: 10 * 60 },
  /** Verification-code requests from signed-in legacy accounts. Keyed on IP. */
  verifyEmail: { limit: 5, windowSeconds: 60 * 60 },
  /** Buddy invites email a person; keep Tambo from pestering a mailbox. */
  buddyInvite: { limit: 5, windowSeconds: 60 * 60 },
  /** Evidence batches. Keyed per device; a live trail is bursty but small. */
  evidenceIngest: { limit: 240, windowSeconds: 60 * 60 },
  /**
   * Photo uploads. Keyed per device. Sized for snapshot bursts (F4): a pro
   * episode may send 20 bursts of 3 frames per camera inside an hour, and a
   * retried frame costs a second hit.
   */
  mediaUpload: { limit: 300, windowSeconds: 60 * 60 },
  /** Full-pack emails fan out to several mailboxes. Keyed on IP. */
  packSend: { limit: 10, windowSeconds: 60 * 60 },
  /** Push-token registration: apps re-register on start; bots must not churn the registry. */
  pushTokenRegister: { limit: 30, windowSeconds: 60 * 60 },
  /**
   * Owner-issued remote commands. Keyed per user; repeat taps converge on the
   * outstanding command anyway, so this only stops scripted hammering.
   */
  deviceCommand: { limit: 30, windowSeconds: 60 * 60 },
  /** The device's command poll. Keyed per device; allows one every 10 s. */
  commandPoll: { limit: 360, windowSeconds: 60 * 60 },
  /** The device's own push-token registration. Keyed per device. */
  devicePushToken: { limit: 30, windowSeconds: 60 * 60 },
  /**
   * The launch handshake. Keyed on IP and generous on purpose: carrier-grade
   * NAT puts thousands of phones behind one address, and a refused handshake
   * must never stop the app opening. The response is cacheable besides.
   */
  clientConfig: { limit: 1200, windowSeconds: 60 * 60 },
  /**
   * Provisioned phones claiming their ingest token (B4). Unauthenticated, so
   * keyed on IP; a phone claims once, and a retry after a lost response
   * costs one more.
   */
  deviceClaim: { limit: 30, windowSeconds: 60 * 60 },
  /** Linking a provisioned phone to an account. Keyed per user. */
  deviceLink: { limit: 10, windowSeconds: 60 * 60 },
  /**
   * The phone's own status card (B5). Keyed per device; a widget refreshes
   * every 30 minutes, an OEM card host may ask more often.
   */
  deviceStatusCard: { limit: 120, windowSeconds: 60 * 60 },
  /** Partner systems. Keyed per API key. */
  partnerApi: { limit: 600, windowSeconds: 60 * 60 },
  /** Check-ins run every 15 minutes; this leaves room for retries. Per device. */
  heartbeat: { limit: 30, windowSeconds: 60 * 60 },
  /** The public mark-stolen link in the quiet alert email. Keyed on IP. */
  alertAction: { limit: 20, windowSeconds: 60 * 60 },
  /** A buddy reporting a friend's phone stolen fans out alerts. Keyed on IP. */
  buddyReport: { limit: 5, windowSeconds: 60 * 60 },
} satisfies Record<string, RateLimitRule>;
