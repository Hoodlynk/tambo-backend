import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import AuthEvent from '../src/models/authEvent.model';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { CREDENTIALS, registerUser, startLogin } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const eventTypes = async (userId: string): Promise<string[]> => {
  const events = await AuthEvent.find({ user: userId }).sort({ at: 1 });
  return events.map((event) => event.type);
};

/** Audit writes are fire-and-forget; give them a beat to land. */
const untilAudited = async (userId: string, type: string): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await AuthEvent.exists({ user: userId, type })) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`audit event ${type} never recorded`);
};

describe('request ids', () => {
  it('mints an id, echoes it, and honours a sane inbound one', async () => {
    const minted = await request(testServer()).get('/api/health');
    expect(minted.get('x-request-id')).toMatch(/^[\w-]{8,}$/);

    const honoured = await request(testServer())
      .get('/api/health')
      .set('X-Request-Id', 'proxy-abc-123');
    expect(honoured.get('x-request-id')).toBe('proxy-abc-123');

    const rejected = await request(testServer())
      .get('/api/health')
      .set('X-Request-Id', 'x'.repeat(200)); // insane: minted instead
    expect(rejected.get('x-request-id')).not.toBe('x'.repeat(200));
  });
});

describe('auth audit trail', () => {
  it('records the login lifecycle: failure, success, and OTP verification', async () => {
    const { userId } = await registerUser();
    // registerUser's OTP verify already logged otp_verified + login_succeeded
    await untilAudited(userId, 'otp_verified');

    await startLogin(CREDENTIALS.email, 'wrong-password');
    await untilAudited(userId, 'login_failed');

    await startLogin();
    await untilAudited(userId, 'login_succeeded');

    const types = await eventTypes(userId);
    expect(types).toContain('otp_verified');
    expect(types).toContain('login_failed');
    expect(types).toContain('login_succeeded');
  });

  it('records revocations, and the owner reads their own trail', async () => {
    const { accessToken, refreshToken, userId } = await registerUser();

    await request(testServer())
      .post('/api/auth/logout-all')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken });
    await untilAudited(userId, 'sessions_revoked_all');

    const res = await request(testServer())
      .get('/api/auth/security-events')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    const types = res.body.events.map((event: { type: string }) => event.type);
    expect(types).toContain('sessions_revoked_all');
    // newest first
    const times = res.body.events.map((event: { at: string }) =>
      new Date(event.at).getTime(),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('never stores codes or tokens in the ledger', async () => {
    const { userId } = await registerUser();
    await untilAudited(userId, 'otp_verified');
    const events = await AuthEvent.find({ user: userId });
    const dump = JSON.stringify(events);
    expect(dump).not.toMatch(/\b\d{6}\b/); // no OTP codes
    expect(dump).not.toContain('passwordHash');
  });
});

describe('account lockout', () => {
  const failLogin = () => startLogin(CREDENTIALS.email, 'wrong-password');

  it('locks after the threshold, answers 423 with retryAfter, and audits it', async () => {
    const { userId } = await registerUser();

    for (let i = 0; i < config.lockout.threshold; i += 1) {
      const res = await failLogin();
      expect(res.status).toBe(401);
    }
    await untilAudited(userId, 'account_locked');

    // locked: even the CORRECT password is refused
    const locked = await startLogin();
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('account_locked');
    expect(locked.body.retryAfter).toBeGreaterThan(0);
    expect(Number(locked.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a successful login resets the failure counter', async () => {
    const { userId } = await registerUser();

    for (let i = 0; i < config.lockout.threshold - 1; i += 1) {
      await failLogin();
    }
    const ok = await startLogin();
    expect(ok.status).toBe(200);

    // counter reset: one more failure does NOT lock
    const after = await failLogin();
    expect(after.status).toBe(401);
    const user = await User.findById(userId);
    expect(user?.lockedUntil).toBeUndefined();
    expect(user?.failedLoginAttempts).toBe(1);
  });

  it('an expired lock lets the user back in; a password reset clears it early', async () => {
    const { userId } = await registerUser();
    for (let i = 0; i < config.lockout.threshold; i += 1) await failLogin();
    await untilAudited(userId, 'account_locked');

    // expire the lock by hand rather than waiting minutes
    await User.updateOne(
      { _id: userId },
      { $set: { lockedUntil: new Date(Date.now() - 1000) } },
    );
    const back = await startLogin();
    expect(back.status).toBe(200);

    // lock again, then reset-password: mailbox control clears the lock
    for (let i = 0; i < config.lockout.threshold; i += 1) await failLogin();
    noopMailer.clear();
    await request(testServer())
      .post('/api/auth/forgot-password')
      .send({ email: CREDENTIALS.email });
    const mail = noopMailer.sent.find((m) => m.subject.includes('Reset'));
    const token = /token=([\w-]+)/.exec(mail?.text ?? '')?.[1];
    expect(token).toBeTruthy();

    const reset = await request(testServer())
      .post('/api/auth/reset-password')
      .send({ token, password: 'brand-new-password-1' });
    expect(reset.status).toBe(200);

    const login = await startLogin(CREDENTIALS.email, 'brand-new-password-1');
    expect(login.status).toBe(200);
    await untilAudited(userId, 'password_reset');
  });
});
