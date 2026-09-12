import request from 'supertest';
import { testServer } from './setup/testServer';
import User from '../src/models/user.model';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import {
  CREDENTIALS,
  EMAIL,
  latestOtpCode,
  loginUser,
  registerUser,
  startLogin,
  startRegister,
  verifyOtp,
} from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

describe('POST /api/auth/register', () => {
  it('returns only a signup challenge - no user, no tokens - and emails the code', async () => {
    const res = await startRegister();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      challenge: expect.objectContaining({ purpose: 'signup' }),
    });
    expect(res.body.challenge.challengeId).toMatch(/^[a-f\d]{24}$/i);
    expect(noopMailer.sent.at(-1)?.to).toBe(EMAIL);

    const stored = await User.findOne({ email: EMAIL });
    expect(stored).not.toBeNull();
    expect(stored?.emailVerifiedAt).toBeUndefined();
  });

  it('verifying the signup code marks the email verified and issues the first session', async () => {
    const res = await startRegister();

    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user).toMatchObject({
      name: 'Ada Lovelace',
      email: EMAIL,
      role: 'user',
    });
    expect(verified.body.user.emailVerifiedAt).toBeTruthy();
    expect(typeof verified.body.tokens.accessToken).toBe('string');
    expect(typeof verified.body.tokens.refreshToken).toBe('string');

    const me = await request(testServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${verified.body.tokens.accessToken}`);
    expect(me.status).toBe(200);

    const stored = await User.findOne({ email: EMAIL });
    expect(stored?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('never exposes the password hash', async () => {
    const res = await startRegister();
    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );

    expect(JSON.stringify(res.body)).not.toContain('$2b$');
    expect(JSON.stringify(verified.body)).not.toContain('$2b$');
    expect(verified.body.user.passwordHash).toBeUndefined();
  });

  it('treats email as case-insensitive for uniqueness', async () => {
    await registerUser();
    const res = await startRegister({ email: 'ADA@TAMBO.APP' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
  });

  it('resolves a concurrent duplicate registration as one 201 and one 409', async () => {
    const results = await Promise.all([startRegister(), startRegister()]);
    const statuses = results.map((r) => r.status).sort();

    expect(statuses).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe(
      'email_taken',
    );
  });

  it('ignores a client-supplied role instead of trusting it', async () => {
    const res = await startRegister({ role: 'admin' } as Partial<
      typeof CREDENTIALS
    >);

    expect(res.status).toBe(201);
    expect((await User.findOne({ email: EMAIL }))?.role).toBe('user');
  });
});

describe('POST /api/auth/login', () => {
  it('returns the user and tokens after the password checks out, ignoring email casing', async () => {
    await registerUser();
    const res = await startLogin('ADA@tambo.app');

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);
    expect(typeof res.body.tokens.accessToken).toBe('string');
    expect(typeof res.body.tokens.refreshToken).toBe('string');
    expect(res.body.challenge).toBeUndefined();
  });

  it('issues a usable session directly', async () => {
    await registerUser();
    const { accessToken } = await loginUser();

    const me = await request(testServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(EMAIL);
  });

  it('gives an identical error for a wrong password and an unknown email', async () => {
    await registerUser();

    const wrongPassword = await startLogin(CREDENTIALS.email, 'nope-nope-nope');
    const unknownEmail = await startLogin(
      'nobody@tambo.app',
      CREDENTIALS.password,
    );

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
    expect(wrongPassword.body.code).toBe('invalid_credentials');
  });

  it('issues an independent session per completed login', async () => {
    const first = await registerUser();
    const second = await loginUser();

    expect(second.refreshToken).not.toBe(first.refreshToken);

    await request(testServer())
      .post('/api/auth/logout')
      .send({ refreshToken: first.refreshToken });

    const stillValid = await request(testServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: second.refreshToken });
    expect(stillValid.status).toBe(200);
  });

  describe('for an account that never verified its signup code', () => {
    it('refuses a session and hands back a fresh signup challenge instead', async () => {
      const registration = await startRegister();
      const registrationCode = latestOtpCode();
      noopMailer.clear();

      const res = await startLogin();

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('email_unverified');
      expect(res.body.tokens).toBeUndefined();
      expect(res.body.challenge).toMatchObject({ purpose: 'signup' });
      expect(res.body.challenge.challengeId).not.toBe(
        registration.body.challenge.challengeId,
      );
      expect(noopMailer.sent.at(-1)?.to).toBe(EMAIL);

      // the registration challenge is superseded; the login one completes signup
      const stale = await verifyOtp(
        registration.body.challenge.challengeId,
        registrationCode,
      );
      expect(stale.status).toBe(401);
      expect(stale.body.code).toBe('invalid_challenge');

      const verified = await verifyOtp(
        res.body.challenge.challengeId,
        latestOtpCode(),
      );
      expect(verified.status).toBe(200);
      expect(verified.body.user.emailVerifiedAt).toBeTruthy();
      expect(typeof verified.body.tokens.accessToken).toBe('string');

      expect((await startLogin()).status).toBe(200);
    });

    it('still checks the password first - a wrong one is invalid_credentials, not a challenge', async () => {
      await startRegister();
      noopMailer.clear();

      const res = await startLogin(CREDENTIALS.email, 'nope-nope-nope');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('invalid_credentials');
      expect(res.body.challenge).toBeUndefined();
      expect(noopMailer.sent).toHaveLength(0);
    });
  });
});

describe('GET /api/auth/me', () => {
  it('returns the caller', async () => {
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(EMAIL);
  });

  it.each([
    ['no header', undefined, 'missing_token'],
    ['wrong scheme', 'Token abc', 'missing_token'],
    ['garbage token', 'Bearer not-a-jwt', 'invalid_token'],
  ])('rejects %s', async (_label, header, code) => {
    const req = request(testServer()).get('/api/auth/me');
    if (header) req.set('Authorization', header);
    const res = await req;

    expect(res.status).toBe(401);
    expect(res.body.code).toBe(code);
  });
});

describe('POST /api/auth/verify-email', () => {
  const requestVerification = (accessToken?: string) => {
    const req = request(testServer()).post('/api/auth/verify-email');
    if (accessToken) req.set('Authorization', `Bearer ${accessToken}`);
    return req;
  };

  /**
   * A session is only ever issued to a verified email now, so the only way to
   * hold one while unverified is a session that predates this rule. Model it.
   */
  const legacyUnverifiedSession = async () => {
    const session = await registerUser();
    await User.updateOne({ email: EMAIL }, { $unset: { emailVerifiedAt: 1 } });
    noopMailer.clear();
    return session;
  };

  it('opens a signup challenge for an unverified account and heals on verify', async () => {
    const { accessToken } = await legacyUnverifiedSession();

    const res = await requestVerification(accessToken);
    expect(res.status).toBe(200);
    expect(res.body.challenge.purpose).toBe('signup');
    expect(noopMailer.sent.at(-1)?.to).toBe(EMAIL);

    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerifiedAt).toBeTruthy();
  });

  it('supersedes any earlier signup challenge', async () => {
    const { accessToken } = await legacyUnverifiedSession();
    const earlier = await startLogin(); // 403 + a signup challenge
    const earlierCode = latestOtpCode();

    await requestVerification(accessToken);

    const stale = await verifyOtp(
      earlier.body.challenge.challengeId,
      earlierCode,
    );
    expect(stale.status).toBe(401);
    expect(stale.body.code).toBe('invalid_challenge');
  });

  it('refuses once the email is verified', async () => {
    const { accessToken } = await registerUser();

    const res = await requestVerification(accessToken);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('email_already_verified');
  });

  it('requires authentication', async () => {
    const res = await requestVerification();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_token');
  });
});
