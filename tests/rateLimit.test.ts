import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import { rateLimits } from '../src/config/rateLimits';
import RateLimit from '../src/models/rateLimit.model';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { CREDENTIALS, EMAIL, registerUser } from './helpers/factories';

/**
 * Limits are disabled globally for the rest of the suite (see tests/setup/env.ts)
 * and re-enabled here with tiny budgets, so we assert the mechanism rather than
 * firing hundreds of requests.
 */
const original = { ...rateLimits };

beforeAll(connectTestDb, 120_000);

beforeEach(() => {
  config.rateLimit.enabled = true;
  rateLimits.login = { limit: 2, windowSeconds: 900 };
  rateLimits.forgotPassword = { limit: 1, windowSeconds: 3600 };
});

afterEach(async () => {
  config.rateLimit.enabled = false;
  Object.assign(rateLimits, original);
  await clearTestDb();
});

afterAll(closeTestDb);

const attemptLogin = (password: string, email = EMAIL) =>
  request(testServer()).post('/api/auth/login').send({ email, password });

describe('login rate limiting', () => {
  it('blocks once the budget is spent and reports Retry-After', async () => {
    await registerUser();

    expect((await attemptLogin('wrong-one')).status).toBe(401);
    expect((await attemptLogin('wrong-two')).status).toBe(401);

    const blocked = await attemptLogin('wrong-three');
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    expect(blocked.body.retryAfter).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('blocks the CORRECT password too once the budget is spent', async () => {
    await registerUser();
    await attemptLogin('wrong-one');
    await attemptLogin('wrong-two');

    // this is the point: a brute-forcer who guesses right on attempt 3 still loses
    expect((await attemptLogin(CREDENTIALS.password)).status).toBe(429);
  });

  it('keys on the email, so one account being attacked does not lock out another', async () => {
    await registerUser();
    await registerUser({ email: 'grace@tambo.app' });

    await attemptLogin('wrong-one');
    await attemptLogin('wrong-two');
    expect((await attemptLogin('wrong-three')).status).toBe(429);

    const otherAccount = await attemptLogin(
      CREDENTIALS.password,
      'grace@tambo.app',
    );
    expect(otherAccount.status).toBe(200);
  });

  it('normalizes the email so casing cannot multiply the budget', async () => {
    await registerUser();
    await attemptLogin('wrong-one', 'ada@tambo.app');
    await attemptLogin('wrong-two', 'ADA@TAMBO.APP');

    expect((await attemptLogin('wrong-three', 'Ada@Tambo.App')).status).toBe(
      429,
    );
  });

  it('anchors the window to the first hit rather than sliding it', async () => {
    await registerUser();
    await attemptLogin('wrong-one');
    const first = await RateLimit.findOne({});
    const anchored = first?.expiresAt.getTime();

    await attemptLogin('wrong-two');
    const second = await RateLimit.findOne({});

    expect(second?.expiresAt.getTime()).toBe(anchored);
  });

  it('does not store the raw email in the counter collection', async () => {
    await registerUser();
    await attemptLogin('wrong-one');

    const counter = await RateLimit.findOne({});
    expect(counter?.key).not.toContain(EMAIL);
  });
});

describe('window expiry', () => {
  it('grants a fresh budget once the window has elapsed, without waiting for the TTL sweep', async () => {
    await registerUser();

    await attemptLogin('wrong-one');
    await attemptLogin('wrong-two');
    expect((await attemptLogin('wrong-three')).status).toBe(429);

    // window elapses, but Mongo's TTL monitor (~60s cadence) has not swept the row
    await RateLimit.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - 5000) } },
    );

    // a fresh window must open immediately - previously this kept 429ing with Retry-After: 1
    expect((await attemptLogin(CREDENTIALS.password)).status).toBe(200);
  });
});

describe('forgot-password rate limiting', () => {
  it('limits reset mail so a mailbox cannot be flooded', async () => {
    await registerUser();

    expect(
      (
        await request(testServer())
          .post('/api/auth/forgot-password')
          .send({ email: EMAIL })
      ).status,
    ).toBe(204);
    const blocked = await request(testServer())
      .post('/api/auth/forgot-password')
      .send({ email: EMAIL });

    expect(blocked.status).toBe(429);
  });
});

describe('rate limiting disabled', () => {
  it('lets everything through when turned off', async () => {
    config.rateLimit.enabled = false;
    await registerUser();

    for (let i = 0; i < 5; i += 1) {
      expect((await attemptLogin('wrong')).status).toBe(401);
    }
  });
});

describe('rate limiting vs account lockout', () => {
  it('429 fires first and throttled attempts never advance the lockout counter', async () => {
    const { userId } = await registerUser();
    const User = (await import('../src/models/user.model')).default;

    expect((await attemptLogin('wrong-one')).status).toBe(401);
    expect((await attemptLogin('wrong-two')).status).toBe(401);
    // budget spent: everything below is 429 and must not touch the account
    for (let i = 0; i < 5; i += 1) {
      expect((await attemptLogin('wrong-again')).status).toBe(429);
    }

    const user = await User.findById(userId);
    // only the two REAL attempts counted; the limiter shields the lockout
    expect(user?.failedLoginAttempts).toBe(2);
    expect(user?.lockedUntil).toBeUndefined();
  });
});
