import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { CREDENTIALS, latestOtpCode, registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const CSRF = { 'X-Tambo-Csrf': '1' };
const COOKIE_NAME = config.authCookie.name;

/** The Set-Cookie line for the refresh cookie, or undefined. */
const refreshCookieOf = (res: request.Response): string | undefined => {
  const header = res.get('set-cookie') ?? [];
  const cookies = Array.isArray(header) ? header : [header];
  return cookies.find((cookie) => cookie.startsWith(`${COOKIE_NAME}=`));
};

/** "name=value" pair to send back, extracted from the Set-Cookie line. */
const cookiePairOf = (res: request.Response): string => {
  const line = refreshCookieOf(res);
  if (!line) throw new Error('no refresh cookie in response');
  return line.split(';')[0]!;
};

const webLogin = () =>
  request(testServer())
    .post('/api/auth/web/login')
    .set(CSRF)
    .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

/** Register (mobile flow), then open a WEB session for the same account. */
const webSession = async () => {
  await registerUser();
  const res = await webLogin();
  expect(res.status).toBe(200);
  return res;
};

describe('POST /api/auth/web/login', () => {
  it('sets an httpOnly, path-scoped refresh cookie and keeps the token out of the body', async () => {
    const res = await webSession();

    const cookie = refreshCookieOf(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/api/auth/web');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=');

    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(
      cookiePairOf(res).split('=')[1],
    );
  });

  it('returns a challenge (and no cookie) for an unproven mailbox', async () => {
    // an account whose signup OTP was never completed
    await request(testServer()).post('/api/auth/register').send(CREDENTIALS);

    const res = await webLogin();
    expect(res.status).toBe(200);
    expect(res.body.challenge.purpose).toBe('login');
    expect(refreshCookieOf(res)).toBeUndefined();
  });
});

describe('CSRF guard', () => {
  it('rejects requests without the custom header', async () => {
    await registerUser();
    const res = await request(testServer())
      .post('/api/auth/web/login')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_rejected');
  });

  it('rejects a browser Origin that is not on the CORS allowlist', async () => {
    await registerUser();
    const res = await request(testServer())
      .post('/api/auth/web/login')
      .set(CSRF)
      .set('Origin', 'https://evil.example')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('csrf_rejected');
  });
});

describe('POST /api/auth/web/refresh', () => {
  it('rotates: a new cookie is set and the old value burns the family on reuse', async () => {
    const login = await webSession();
    const firstPair = cookiePairOf(login);

    const refreshed = await request(testServer())
      .post('/api/auth/web/refresh')
      .set(CSRF)
      .set('Cookie', firstPair);
    expect(refreshed.status).toBe(200);
    const secondPair = cookiePairOf(refreshed);
    expect(secondPair).not.toBe(firstPair);

    // replaying the rotated (old) cookie is reuse: the whole family burns
    const replay = await request(testServer())
      .post('/api/auth/web/refresh')
      .set(CSRF)
      .set('Cookie', firstPair);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('refresh_token_reused');

    const afterBurn = await request(testServer())
      .post('/api/auth/web/refresh')
      .set(CSRF)
      .set('Cookie', secondPair);
    expect(afterBurn.status).toBe(401);
  });

  it('401s with missing_refresh_cookie when the cookie is absent', async () => {
    const res = await request(testServer())
      .post('/api/auth/web/refresh')
      .set(CSRF);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_refresh_cookie');
  });
});

describe('POST /api/auth/web/logout', () => {
  it('revokes the session, clears the cookie, and is idempotent', async () => {
    const login = await webSession();
    const pair = cookiePairOf(login);

    const out = await request(testServer())
      .post('/api/auth/web/logout')
      .set(CSRF)
      .set('Cookie', pair);
    expect(out.status).toBe(204);
    const cleared = refreshCookieOf(out);
    expect(cleared).toContain(`${COOKIE_NAME}=;`);

    // the revocation is real: the cookie no longer refreshes
    const res = await request(testServer())
      .post('/api/auth/web/refresh')
      .set(CSRF)
      .set('Cookie', pair);
    expect(res.status).toBe(401);

    // logging out again (no cookie) is still a quiet 204
    const again = await request(testServer())
      .post('/api/auth/web/logout')
      .set(CSRF);
    expect(again.status).toBe(204);
  });
});

describe('cross-surface session machinery', () => {
  it('a cookie-issued token refreshes on the mobile surface too - one session service', async () => {
    const login = await webSession();
    const token = cookiePairOf(login).split('=').slice(1).join('=');

    const res = await request(testServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: token });
    expect(res.status).toBe(200);
    expect(res.body.tokens.refreshToken).toBeTruthy();
  });

  it('web OTP verify completes a mobile-started signup with a cookie session', async () => {
    const registration = await request(testServer())
      .post('/api/auth/register')
      .send(CREDENTIALS);
    const res = await request(testServer())
      .post('/api/auth/web/otp/verify')
      .set(CSRF)
      .send({
        challengeId: registration.body.challenge.challengeId,
        code: latestOtpCode(),
      });
    expect(res.status).toBe(200);
    expect(refreshCookieOf(res)).toContain('HttpOnly');
    expect(res.body.tokens.refreshToken).toBeUndefined();
  });
});
