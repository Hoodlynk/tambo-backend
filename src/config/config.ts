import dotenv from 'dotenv';

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

  const secure = process.env.AUTH_COOKIE_SECURE !== 'false';
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
  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  authCookie: parseAuthCookie(),
  trustProxy: parseTrustProxy(),
};

export default config;
