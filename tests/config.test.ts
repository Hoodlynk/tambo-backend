/**
 * Boot-time validation: a misconfigured deployment must refuse to start, not
 * silently degrade to insecure behavior. Each case loads config fresh in an
 * isolated module registry with a manipulated environment.
 *
 * dotenv never overrides an already-set variable, so setting a key to '' here
 * both defeats .env and reads as "unset" to the validators.
 */

const ENV_KEYS = [
  'NODE_ENV',
  'JWT_ACCESS_SECRET',
  'TRUST_PROXY',
  'MAIL_DRIVER',
  'RESEND_API_KEY',
  'MONGODB_URI',
  'PACK_SIGNING_SEED',
  'PUSH_DRIVER',
  'FCM_SERVICE_ACCOUNT_JSON',
  'AUTH_COOKIE_NAME',
  'AUTH_COOKIE_SAMESITE',
  'AUTH_COOKIE_SECURE',
] as const;

const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const loadConfig = (): unknown => {
  let loaded: unknown;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('../src/config/config').default;
  });
  return loaded;
};

describe('JWT_ACCESS_SECRET fallback', () => {
  it('refuses to boot in production without a secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = '';
    expect(loadConfig).toThrow(/JWT_ACCESS_SECRET must be set/);
  });

  it('refuses to boot in staging (or any non-local env) without a secret', () => {
    process.env.NODE_ENV = 'staging';
    process.env.JWT_ACCESS_SECRET = '';
    expect(loadConfig).toThrow(/JWT_ACCESS_SECRET must be set/);
  });

  it('refuses to boot when NODE_ENV is unset and no secret is given', () => {
    // '' rather than delete: dotenv would re-fill a deleted NODE_ENV from the
    // local .env file, but never overrides an existing (even empty) variable.
    process.env.NODE_ENV = '';
    process.env.JWT_ACCESS_SECRET = '';
    expect(loadConfig).toThrow(/JWT_ACCESS_SECRET must be set/);
  });

  it('allows (and announces) the fallback only in explicit development', () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    process.env.NODE_ENV = 'development';
    process.env.JWT_ACCESS_SECRET = '';

    expect(loadConfig).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('INSECURE'));
    warn.mockRestore();
  });
});

describe('TRUST_PROXY', () => {
  it('rejects the conventional but unsafe "true"', () => {
    process.env.TRUST_PROXY = 'true';
    expect(loadConfig).toThrow(/TRUST_PROXY must be the number/);
  });

  it('accepts an explicit hop count', () => {
    process.env.TRUST_PROXY = '2';
    const config = loadConfig() as { trustProxy: number };
    expect(config.trustProxy).toBe(2);
  });

  it('defaults to 0 when unset', () => {
    delete process.env.TRUST_PROXY;
    const config = loadConfig() as { trustProxy: number };
    expect(config.trustProxy).toBe(0);
  });
});

describe('MAIL_DRIVER', () => {
  it('refuses to boot on an unknown driver instead of silently logging mail', () => {
    process.env.MAIL_DRIVER = 'sendgrid';
    expect(loadConfig).toThrow(/MAIL_DRIVER must be one of/);
  });

  it('refuses to boot as resend without an API key', () => {
    process.env.MAIL_DRIVER = 'resend';
    process.env.RESEND_API_KEY = ''; // '' defeats dotenv (see note above)
    expect(loadConfig).toThrow(/RESEND_API_KEY must be set/);
  });

  it('accepts the known drivers', () => {
    process.env.RESEND_API_KEY = 're_test_key';
    for (const driver of ['console', 'noop', 'resend']) {
      process.env.MAIL_DRIVER = driver;
      expect(loadConfig).not.toThrow();
    }
  });

  it('errorHandler detail leak is gated on EXPLICIT development', () => {
    // '' simulates unset (see note above about dotenv)
    process.env.NODE_ENV = '';
    process.env.JWT_ACCESS_SECRET = 'some-real-secret';
    const config = loadConfig() as { isDevelopment: boolean; nodeEnv: string };
    expect(config.nodeEnv).toBe('development'); // legacy default label
    expect(config.isDevelopment).toBe(false); // but not treated as dev for leaks
  });
});

describe('auth cookie config', () => {
  it('refuses SameSite=none without Secure', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'none';
    process.env.AUTH_COOKIE_SECURE = 'false';
    expect(loadConfig).toThrow(/requires Secure/);
  });

  it('refuses an unknown SameSite value', () => {
    process.env.AUTH_COOKIE_SAMESITE = 'sideways';
    expect(loadConfig).toThrow(/AUTH_COOKIE_SAMESITE must be one of/);
  });

  it('refuses Secure=false outside development/test', () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_ACCESS_SECRET = 'some-real-secret';
    process.env.MONGODB_URI = 'mongodb://localhost/x';
    process.env.PACK_SIGNING_SEED = 'a'.repeat(64);
    process.env.AUTH_COOKIE_SECURE = 'false';
    expect(loadConfig).toThrow(/AUTH_COOKIE_SECURE=false is allowed only/);
  });

  it('defaults to a Lax, Secure cookie named tambo_rt', () => {
    process.env.AUTH_COOKIE_SAMESITE = '';
    process.env.AUTH_COOKIE_SECURE = '';
    process.env.AUTH_COOKIE_NAME = '';
    const config = loadConfig() as {
      authCookie: { name: string; sameSite: string; secure: boolean };
    };
    expect(config.authCookie).toEqual({
      name: 'tambo_rt',
      sameSite: 'lax',
      secure: true,
    });
  });
});

describe('PUSH_DRIVER', () => {
  it('refuses to boot on an unknown driver', () => {
    process.env.PUSH_DRIVER = 'apns';
    expect(loadConfig).toThrow(/PUSH_DRIVER must be one of/);
  });

  it('refuses to boot as fcm without credentials', () => {
    process.env.PUSH_DRIVER = 'fcm';
    process.env.FCM_SERVICE_ACCOUNT_JSON = '';
    expect(loadConfig).toThrow(/FCM_SERVICE_ACCOUNT_JSON must be set/);
  });

  it('defaults to noop under test, and accepts the known drivers', () => {
    process.env.PUSH_DRIVER = '';
    const config = loadConfig() as { push: { driver: string } };
    expect(config.push.driver).toBe('noop');
    process.env.FCM_SERVICE_ACCOUNT_JSON = 'eyJmYWtlIjogdHJ1ZX0=';
    for (const driver of ['console', 'noop', 'fcm']) {
      process.env.PUSH_DRIVER = driver;
      expect(loadConfig).not.toThrow();
    }
  });
});
