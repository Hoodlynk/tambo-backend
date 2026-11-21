import request from 'supertest';
import { testServer } from './setup/testServer';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
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
  it('returns a signup challenge, not a session - the mailbox must be proven first', async () => {
    const res = await startRegister();

    expect(res.status).toBe(201);
    expect(res.body.challenge).toMatchObject({ purpose: 'signup' });
    expect(typeof res.body.challenge.challengeId).toBe('string');
    expect(res.body.tokens).toBeUndefined();
    expect(res.body.user).toBeUndefined();

    // the account exists but is NOT verified until the code is entered
    const user = await User.findOne({ email: EMAIL });
    expect(user).toBeTruthy();
    expect(user?.emailVerifiedAt).toBeUndefined();

    // the code was emailed to the address being claimed
    expect(noopMailer.sent.at(-1)?.to).toBe(EMAIL);
    expect(noopMailer.sent.at(-1)?.subject).toContain('Verify');
  });

  it('verifying the signup code marks the email verified and starts the session', async () => {
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
  });

  it('never exposes the password hash', async () => {
    const res = await startRegister();

    expect(JSON.stringify(res.body)).not.toContain('$2b$');
    expect(res.body.user).toBeUndefined();
  });

  it('rejects a VERIFIED email as taken, case-insensitively', async () => {
    await registerUser();
    const res = await startRegister({ email: 'ADA@TAMBO.APP' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_taken');
  });

  it('lets a new registration supersede an UNVERIFIED account (no address squatting)', async () => {
    // an abandoned signup with one password...
    await startRegister({ password: 'first-try-password' });

    // ...is superseded by a fresh registration with another
    const second = await startRegister({ password: 'second-try-password' });
    expect(second.status).toBe(201);
    expect(await User.countDocuments({ email: EMAIL })).toBe(1);

    // only the NEWEST code completes it, and the new password is the one that counts
    const verified = await verifyOtp(
      second.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);

    expect((await startLogin(EMAIL, 'first-try-password')).status).toBe(401);
    expect((await startLogin(EMAIL, 'second-try-password')).status).toBe(200);
  });

  it('ignores a client-supplied role instead of trusting it', async () => {
    const res = await startRegister({ role: 'admin' } as Partial<
      typeof CREDENTIALS
    >);
    expect(res.status).toBe(201);

    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.body.user.role).toBe('user');
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

  it('issues a usable session directly for a verified account', async () => {
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

  it('returns a login challenge - not a session - when the mailbox was never proven', async () => {
    await startRegister(); // registered, signup code never entered

    // a current client says so; header-less builds get the 403 shape
    // (legacyClient.test.ts)
    const res = await request(testServer())
      .post('/api/auth/login')
      .set('X-Client-Platform', 'android')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(res.status).toBe(200);
    expect(res.body.challenge).toMatchObject({ purpose: 'login' });
    expect(res.body.tokens).toBeUndefined();

    // completing the login code heals verification and starts the session
    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user.emailVerifiedAt).toBeTruthy();
    expect(typeof verified.body.tokens.accessToken).toBe('string');
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
