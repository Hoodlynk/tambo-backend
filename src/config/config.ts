import dotenv from 'dotenv';
import { CLIENT_PLATFORMS, SEMVER_PATTERN } from './client';
import type { ClientPlatform } from './client';
import { compareVersions } from '../utils/version';

dotenv.config();

/**
 * Captured BEFORE defaulting: several security decisions below must
 * distinguish "explicitly development" from "nobody set NODE_ENV", because a
 * container that forgot to set it must fail safe, not fail open.
 */
const rawNodeEnv = process.env.NODE_ENV;
const isLocalEnv = rawNodeEnv === 'development' || rawNodeEnv === 'test';

const MAIL_DRIVERS = ['console', 'noop', 'resend'] as const;
type MailDriver = (typeof MAIL_DRIVERS)[number];

const COOKIE_SAMESITE = ['strict', 'lax', 'none'] as const;
export type CookieSameSite = (typeof COOKIE_SAMESITE)[number];

const PUSH_DRIVERS = ['console', 'noop', 'fcm'] as const;
type PushDriver = (typeof PUSH_DRIVERS)[number];

const CLAIM_INTEGRITY_MODES = ['off', 'required'] as const;
type ClaimIntegrity = (typeof CLAIM_INTEGRITY_MODES)[number];

interface Config {
  port: number;
  nodeEnv: string;
  /** True only when NODE_ENV is explicitly "development" - never by default. */
  isDevelopment: boolean;
  mongodbUri: string;
  bcryptRounds: number;
  jwt: {
    accessSecret: string;
    accessTtl: string;
    refreshTtlDays: number;
  };
  passwordReset: {
    ttlMinutes: number;
  };
  otp: {
    /** How long a code stays valid. */
    ttlMinutes: number;
    /** Wrong guesses before the challenge burns. 6 digits = 1e6 codes, so keep small. */
    maxAttempts: number;
    /** Minimum seconds between sends for one challenge. */
    resendCooldownSeconds: number;
  };
  buddies: {
    /** Per user. Alerts fan out to each accepted buddy; keep the blast radius small. */
    max: number;
    /** Minimum seconds between (re-)invite emails for one buddy. */
    inviteCooldownSeconds: number;
  };
  evidence: {
    /** Routine envelopes (no theft episode) self-delete after this. */
    retentionRoutineDays: number;
    /** Envelopes attached to a theft episode live this long. */
    retentionEpisodeDays: number;
    /** UNLOCK_FAILED events inside this window count toward the threshold. */
    thresholdWindowMinutes: number;
    /** When an episode opens, envelopes received this recently are pulled in. */
    backAttachMinutes: number;
    /** Envelopes per ingest batch. */
    maxBatch: number;
    /** Per-envelope payload string length. */
    maxPayloadChars: number;
    /** Photo upload cap, bytes. */
    maxMediaBytes: number;
  };
  /**
   * The "went quiet" watchdog: a phone that stops checking in is the one
   * signal a thief who flips airplane mode or powers off cannot suppress.
   */
  watchdog: {
    /** Silence after an unresolved failed unlock / locked boot that alerts the owner. */
    quietAfterMinutes: number;
    /** A suspicious signal older than this no longer arms the quiet alert. */
    suspicionLookbackHours: number;
    /** Plain silence (nothing suspicious seen) that alerts the owner. 0 disables. */
    silentAfterHours: number;
    /** How often the sweep runs. */
    sweepIntervalSeconds: number;
    /** Lifetime of the one-tap "mark stolen" link in the alert email. */
    actionLinkTtlHours: number;
  };
  /**
   * Public base URL of THIS API, used to build links a browser opens (e.g.
   * buddy-invite links). Distinct from mail.appUrl, which is the
   * mobile deep-link scheme.
   */
  publicApiUrl: string;
  /** 32-byte hex seed for the Ed25519 key that signs evidence-pack manifests. */
  packSigningSeed: string;
  mail: {
    /** 'console' logs to stdout, 'noop' discards. Real providers slot in here. */
    driver: MailDriver;
    from: string;
    /** Required when driver is 'resend'; validated at boot. */
    resendApiKey: string;
    /** Deep-link base the mobile app handles, used to build reset links. */
    appUrl: string;
  };
  rateLimit: {
    /** Disable in tests that are not specifically exercising limits. */
    enabled: boolean;
  };
  log: {
    /** pino level; 'silent' under test unless LOG_LEVEL says otherwise. */
    level: string;
  };
  lockout: {
    /** Consecutive failed password logins before the account locks. */
    threshold: number;
    /** How long a lock lasts. Password reset clears it early. */
    durationMinutes: number;
  };
  push: {
    /** 'console' logs to stdout, 'noop' discards; 'fcm' is the real provider. */
    driver: PushDriver;
    /** Base64-encoded Firebase service-account JSON; required iff driver=fcm. */
    fcmServiceAccountJson: string;
    /** Registered device tokens per user; least-recently-seen evicted beyond it. */
    maxTokensPerUser: number;
  };
  /**
   * The legal documents users must accept. The content LIVES on the website;
   * the API serves version + URL, records acceptances, and tells the app when
   * a user's acceptance is stale. Bump a version here (env) whenever the
   * document changes materially - every user is then re-prompted.
   */
  legal: {
    terms: { version: string; url: string };
    privacy: { version: string; url: string };
  };
  /**
   * Per-platform app version policy served by GET /client/config. Below
   * `minimum` the app must update before continuing; below `recommended` it
   * nudges. 0.0.0 (the default) means "no policy yet".
   */
  clientVersions: Record<
    ClientPlatform,
    { minimum: string; recommended: string }
  >;
  cors: {
    /** Empty means "no browser origins allowed" - correct for a mobile-only API. */
    allowedOrigins: string[];
  };
  /**
   * The browser (PWA) auth surface at /api/auth/web keeps the refresh token in
   * an httpOnly cookie instead of the JSON body, so page scripts can never
   * read it. Mobile clients are unaffected.
   */
  authCookie: {
    name: string;
    sameSite: CookieSameSite;
    /** May be false only in explicit development/test (plain-http localhost). */
    secure: boolean;
  };
  /**
   * Number of reverse proxies in front of the app. MUST be accurate: too high
   * and a client can spoof its IP via X-Forwarded-For, defeating rate limiting.
   * 0 means "no proxy, use the socket address".
   */
  trustProxy: number;
  /**
   * Device claim (B4). `required` makes every claim present a Play Integrity
   * token the verifier accepts; `off` takes the provisioning token alone.
   */
  claim: { integrity: ClaimIntegrity };
  /** Partner webhooks (B5). */
  webhooks: {
    /**
     * Lets endpoints use plain http and private, loopback or link-local
     * addresses. Development and test only: in production a partner-supplied
     * URL must never reach the internal network.
     */
    allowLocalTargets: boolean;
    /** Per-attempt timeout for the partner's endpoint. */
    timeoutMs: number;
  };
  legacyClients: {
    /**
     * Lets builds that send no X-Client-Platform enrol without a recorded
     * legal acceptance (the Play build keeps its terms sheet on the phone
     * only). Switch off once the update that calls /legal/accept is the
     * minimum version.
     */
    legalExempt: boolean;
  };
}

/**
 * Reads a variable the app cannot safely run without. The built-in fallback is
 * allowed ONLY when NODE_ENV is explicitly development or test - production,
 * staging, typos, and an unset NODE_ENV all refuse to boot, and even the
 * permitted fallback announces itself so it can never engage silently.
 */
const required = (key: string, devFallback: string): string => {
  const value = process.env[key];
  if (value) return value;

  if (!isLocalEnv) {
    throw new Error(
      `${key} must be set when NODE_ENV is "${rawNodeEnv ?? '(unset)'}". ` +
        'Only an explicit NODE_ENV of development or test may omit it.',
    );
  }

  console.warn(
    `[config] ${key} is not set - using an INSECURE built-in ${rawNodeEnv} fallback.`,
  );
  return devFallback;
};

/**
 * TRUST_PROXY feeds req.ip, which keys the rate limiter. Express accepts
 * booleans here, but "true" means "trust every proxy" - which lets any client
 * forge X-Forwarded-For - so only an explicit hop count is accepted, and
 * anything else (including the conventional "true") refuses to boot rather
 * than silently degrading to 0.
 */
const parseTrustProxy = (): number => {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY must be the number of reverse proxies in front of the app (e.g. 1); got "${raw}".`,
    );
  }
  return Number(raw);
};

/** A typo'd driver must fail at boot, not silently print reset tokens to stdout. */
const parseMailDriver = (): MailDriver => {
  const raw = process.env.MAIL_DRIVER || 'console';
  if (!(MAIL_DRIVERS as readonly string[]).includes(raw)) {
    throw new Error(
      `MAIL_DRIVER must be one of: ${MAIL_DRIVERS.join(', ')}; got "${raw}".`,
    );
  }
  if (raw === 'resend' && !process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY must be set when MAIL_DRIVER is "resend".');
  }
  return raw as MailDriver;
};

/** Positive-integer env knob: garbage or zero refuses to boot (house rule). */
const positiveInt = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${key} must be a positive integer; got "${raw}".`);
  }
  return Number(raw);
};

/** Mirror of parseMailDriver: a typo'd push driver must fail at boot. */
const parsePushDriver = (): PushDriver => {
  const raw =
    process.env.PUSH_DRIVER || (rawNodeEnv === 'test' ? 'noop' : 'console');
  if (!(PUSH_DRIVERS as readonly string[]).includes(raw)) {
    throw new Error(
      `PUSH_DRIVER must be one of: ${PUSH_DRIVERS.join(', ')}; got "${raw}".`,
    );
  }
  if (raw === 'fcm') {
    const encoded = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!encoded) {
      throw new Error(
        'FCM_SERVICE_ACCOUNT_JSON must be set when PUSH_DRIVER is "fcm".',
      );
    }
    // fail at BOOT, not on the first theft alert: a truncated/corrupt value
    // would otherwise surface only when a push is attempted
    try {
      JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      throw new Error(
        'FCM_SERVICE_ACCOUNT_JSON must be base64-encoded JSON (a Firebase service-account key).',
      );
    }
  }
  return raw as PushDriver;
};

/**
 * The pack-signing seed follows the JWT-secret rules: a built-in fallback only
 * in explicit development/test (announced), refusal to boot anywhere else -
 * and it must be a stable 64-hex-char value, because rotating it silently
 * would break verification of every pack already delivered.
 */
const parsePackSigningSeed = (): string => {
  const value = required(
    'PACK_SIGNING_SEED',
    'a4dc0ffee0ddba11ca11ab1eca55e77e5eed5eed5eed5eed5eed5eed5eed5eed',
  );
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new Error(
      'PACK_SIGNING_SEED must be 64 hex characters (a 32-byte seed).',
    );
  }
  return value;
};

/**
 * Cookie flags fail closed: SameSite=none requires Secure (browsers refuse the
 * cookie otherwise, which would present as "login works, refresh doesn't"),
 * and turning Secure off is a development-only concession.
 */
const parseAuthCookie = (): Config['authCookie'] => {
  const rawSameSite = process.env.AUTH_COOKIE_SAMESITE || 'lax';
  if (!(COOKIE_SAMESITE as readonly string[]).includes(rawSameSite)) {
    throw new Error(
      `AUTH_COOKIE_SAMESITE must be one of: ${COOKIE_SAMESITE.join(', ')}; got "${rawSameSite}".`,
    );
  }
  const sameSite = rawSameSite as CookieSameSite;

  const rawSecure = process.env.AUTH_COOKIE_SECURE || 'true';
  if (rawSecure !== 'true' && rawSecure !== 'false') {
    // '0'/'no'/'False' silently meaning Secure=true would produce the exact
    // "login works, refresh doesn't" trap this flag exists to prevent
    throw new Error(
      `AUTH_COOKIE_SECURE must be "true" or "false"; got "${rawSecure}".`,
    );
  }
  const secure = rawSecure === 'true';
  if (!secure && !isLocalEnv) {
    throw new Error(
      'AUTH_COOKIE_SECURE=false is allowed only when NODE_ENV is explicitly development or test.',
    );
  }
  if (sameSite === 'none' && !secure) {
    throw new Error(
      'AUTH_COOKIE_SAMESITE=none requires Secure cookies; browsers reject the pair otherwise.',
    );
  }

  return {
    name: process.env.AUTH_COOKIE_NAME || 'tambo_rt',
    sameSite,
    secure,
  };
};

/**
 * A typo'd minimum version would either lock every user out or silently
 * enforce nothing, so a malformed value, or a minimum above the recommended
 * version, refuses to boot.
 */
const parseClientVersions = (): Config['clientVersions'] => {
  const read = (key: string): string => {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return '0.0.0';
    if (!SEMVER_PATTERN.test(raw)) {
      throw new Error(`${key} must be a version like 1.4.0; got "${raw}".`);
    }
    return raw;
  };
  const entries = CLIENT_PLATFORMS.map((platform) => {
    const suffix = platform.toUpperCase();
    const minimum = read(`CLIENT_MIN_VERSION_${suffix}`);
    const recommended = read(`CLIENT_RECOMMENDED_VERSION_${suffix}`);
    if (compareVersions(minimum, recommended) > 0) {
      throw new Error(
        `CLIENT_MIN_VERSION_${suffix} (${minimum}) is above ` +
          `CLIENT_RECOMMENDED_VERSION_${suffix} (${recommended}).`,
      );
    }
    return [platform, { minimum, recommended }] as const;
  });
  return Object.fromEntries(entries) as Config['clientVersions'];
};

/**
 * No production Play Integrity verifier exists yet (docs/roadmap.md), and the
 * placeholder rejects every token - so "required" outside development/test
 * would refuse every factory phone's claim. That refuses to boot instead.
 */
const parseClaimIntegrity = (): ClaimIntegrity => {
  const raw = process.env.CLAIM_INTEGRITY || 'off';
  if (!(CLAIM_INTEGRITY_MODES as readonly string[]).includes(raw)) {
    throw new Error(
      `CLAIM_INTEGRITY must be one of: ${CLAIM_INTEGRITY_MODES.join(', ')}; got "${raw}".`,
    );
  }
  if (raw === 'required' && !isLocalEnv) {
    throw new Error(
      'CLAIM_INTEGRITY=required needs a Play Integrity verifier, and none is ' +
        'built yet; it would refuse every device claim.',
    );
  }
  return raw as ClaimIntegrity;
};

/** Mirrors parseClaimIntegrity: an SSRF door must not open by accident. */
const parseWebhookLocalTargets = (): boolean => {
  const raw = process.env.WEBHOOK_ALLOW_LOCAL_TARGETS || 'false';
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      `WEBHOOK_ALLOW_LOCAL_TARGETS must be true or false; got "${raw}".`,
    );
  }
  if (raw === 'true' && !isLocalEnv) {
    throw new Error(
      'WEBHOOK_ALLOW_LOCAL_TARGETS=true lets partner-supplied URLs reach ' +
        'private addresses; it is allowed only in development and test.',
    );
  }
  return raw === 'true';
};

/** Strict true|false: a typo must not silently pick a legal posture. */
const parseLegacyLegalExempt = (): boolean => {
  const raw = process.env.LEGACY_CLIENT_LEGAL_EXEMPT || 'true';
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(
      `LEGACY_CLIENT_LEGAL_EXEMPT must be true or false; got "${raw}".`,
    );
  }
  return raw === 'true';
};

const config: Config = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: rawNodeEnv || 'development',
  isDevelopment: rawNodeEnv === 'development',
  mongodbUri: process.env.MONGODB_URI || '',
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  jwt: {
    accessSecret: required(
      'JWT_ACCESS_SECRET',
      'dev-only-insecure-access-secret',
    ),
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS) || 30,
  },
  passwordReset: {
    ttlMinutes: Number(process.env.PASSWORD_RESET_TTL_MINUTES) || 60,
  },
  otp: {
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES) || 10,
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS) || 5,
    resendCooldownSeconds:
      Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 60,
  },
  buddies: {
    max: Number(process.env.BUDDIES_MAX) || 3,
    inviteCooldownSeconds:
      Number(process.env.BUDDY_INVITE_COOLDOWN_SECONDS) || 300,
  },
  evidence: {
    retentionRoutineDays:
      Number(process.env.EVIDENCE_RETENTION_ROUTINE_DAYS) || 90,
    retentionEpisodeDays:
      Number(process.env.EVIDENCE_RETENTION_EPISODE_DAYS) || 365,
    thresholdWindowMinutes: Number(process.env.THRESHOLD_WINDOW_MINUTES) || 10,
    backAttachMinutes: Number(process.env.BACK_ATTACH_MINUTES) || 60,
    maxBatch: Number(process.env.EVIDENCE_MAX_BATCH) || 100,
    maxPayloadChars: Number(process.env.EVIDENCE_MAX_PAYLOAD_CHARS) || 8000,
    maxMediaBytes:
      Number(process.env.EVIDENCE_MAX_MEDIA_BYTES) || 8 * 1024 * 1024,
  },
  watchdog: {
    quietAfterMinutes: Number(process.env.QUIET_AFTER_MINUTES) || 30,
    suspicionLookbackHours:
      Number(process.env.QUIET_SUSPICION_LOOKBACK_HOURS) || 24,
    // `?? 24` rather than `|| 24` so an explicit 0 can switch the tier off
    silentAfterHours: Number(process.env.SILENT_AFTER_HOURS ?? 24),
    sweepIntervalSeconds: Number(process.env.QUIET_SWEEP_SECONDS) || 60,
    actionLinkTtlHours: Number(process.env.ALERT_ACTION_TTL_HOURS) || 72,
  },
  publicApiUrl:
    process.env.API_PUBLIC_URL ||
    `http://localhost:${Number(process.env.PORT) || 3000}`,
  packSigningSeed: parsePackSigningSeed(),
  mail: {
    driver: parseMailDriver(),
    from: process.env.MAIL_FROM || 'Tambo <no-reply@tambo.local>',
    resendApiKey: process.env.RESEND_API_KEY || '',
    appUrl: process.env.APP_URL || 'tambo://',
  },
  rateLimit: {
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  },
  legal: {
    // the live documents on the website; both state "Version 1.0" on-page -
    // keep the version here in lockstep with what the page says
    terms: {
      version: process.env.TERMS_VERSION || '1.0',
      url: process.env.TERMS_URL || 'https://tambo-app.com/terms',
    },
    privacy: {
      version: process.env.PRIVACY_VERSION || '1.0',
      url: process.env.PRIVACY_URL || 'https://tambo-app.com/privacy',
    },
  },
  clientVersions: parseClientVersions(),
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  log: {
    level: process.env.LOG_LEVEL || (rawNodeEnv === 'test' ? 'silent' : 'info'),
  },
  lockout: {
    threshold: positiveInt('LOCKOUT_THRESHOLD', 10),
    durationMinutes: positiveInt('LOCKOUT_DURATION_MINUTES', 15),
  },
  push: {
    driver: parsePushDriver(),
    fcmServiceAccountJson: process.env.FCM_SERVICE_ACCOUNT_JSON || '',
    // clamped to FCM's 500-token multicast hard limit: a value above it
    // would make every send to a heavy user fail outright
    maxTokensPerUser: Math.min(
      500,
      positiveInt('PUSH_MAX_TOKENS_PER_USER', 10),
    ),
  },
  authCookie: parseAuthCookie(),
  trustProxy: parseTrustProxy(),
  claim: { integrity: parseClaimIntegrity() },
  webhooks: {
    allowLocalTargets: parseWebhookLocalTargets(),
    timeoutMs: positiveInt('WEBHOOK_TIMEOUT_MS', 10_000),
  },
  legacyClients: { legalExempt: parseLegacyLegalExempt() },
};

export default config;
