import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import {
  CREDENTIALS,
  latestOtpCode,
  registerUser,
  startLogin,
  startRegister,
  verifyOtp,
} from './helpers/factories';

/**
 * The app on Google Play was built before the X-Client-* headers existed and
 * against the API as it stood at Kevin's commit 2d8b7d0. Installed builds
 * outlive every deploy, so this file replays exactly the calls that build
 * makes - no client headers, only the fields it sends - and asserts only the
 * fields it reads. A failure here means a deploy would break live users.
 */

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('published app: sign-up and sign-in', () => {
  it('finishes an abandoned sign-up from the 403 email_unverified it was built for', async () => {
    const registration = await startRegister();
    expect(registration.status).toBe(201);
    expect(registration.body.challenge.challengeId).toEqual(expect.any(String));

    // no X-Client-Platform: that is how this build identifies itself
    const login = await startLogin();
    expect(login.status).toBe(403);
    expect(login.body).toMatchObject({
      code: 'email_unverified',
      challenge: { challengeId: expect.any(String), purpose: 'login' },
    });
    expect(login.body.message).toEqual(expect.any(String));

    // VerifyOtpScreen sends only { challengeId, code } whatever the purpose
    const verified = await verifyOtp(
      login.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user.name).toBe(CREDENTIALS.name);
    expect(verified.body.tokens).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(String),
    });
  });

  it('still hands current clients the 200 challenge body', async () => {
    await startRegister();
    const login = await request(testServer())
      .post('/api/auth/login')
      .set('X-Client-Platform', 'android')
      .set('X-Client-Version', '1.1.0')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });

    expect(login.status).toBe(200);
    expect(login.body.challenge).toMatchObject({ purpose: 'login' });
    expect(login.body.code).toBeUndefined();
  });

  it('signs a verified account straight in with { user, tokens }', async () => {
    await registerUser();
    const login = await startLogin();

    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ name: CREDENTIALS.name });
    expect(login.body.tokens.refreshToken).toEqual(expect.any(String));
  });

  it('refreshes, reads /auth/me and /auth/sessions, and logs out by refresh token', async () => {
    const { accessToken, refreshToken } = await registerUser();

    const refreshed = await request(testServer())
      .post('/api/auth/refresh')
      .send({ refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.tokens).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: expect.any(String),
    });

    const access = refreshed.body.tokens.accessToken as string;
    const me = await request(testServer())
      .get('/api/auth/me')
      .set(bearer(access));
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ name: CREDENTIALS.name });

    const sessions = await request(testServer())
      .get('/api/auth/sessions')
      .set(bearer(access));
    expect(sessions.status).toBe(200);
    expect(sessions.body.sessions[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        current: expect.any(Boolean),
      }),
    );

    const loggedOut = await request(testServer())
      .post('/api/auth/logout')
      .send({ refreshToken: refreshed.body.tokens.refreshToken });
    expect(loggedOut.status).toBe(204);
    // the first token was rotated away; the app never replays it
    expect(accessToken).toEqual(expect.any(String));
  });

  it('opens a password-change challenge and answers forgot-password without leaking', async () => {
    const { accessToken } = await registerUser();

    const change = await request(testServer())
      .post('/api/auth/change-password')
      .set(bearer(accessToken))
      .send({
        currentPassword: CREDENTIALS.password,
        newPassword: 'another-long-passphrase',
      });
    expect(change.status).toBe(200);
    expect(change.body.challenge).toMatchObject({
      purpose: 'password_change',
    });

    const forgot = await request(testServer())
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@tambo.app' });
    expect(forgot.status).toBe(204);
  });
});

describe('published app: devices, buddies, protecting', () => {
  it('enrols by installId alone and is idempotent for the same install', async () => {
    // this build never records a legal acceptance server-side
    const { accessToken } = await registerUser(undefined, {
      acceptLegal: false,
    });
    const body = {
      name: 'Tecno Spark',
      make: 'Tecno',
      deviceModel: 'Spark 20',
      installId: 'a1b2c3d4-0000-4000-8000-000000000001',
    };

    const first = await request(testServer())
      .post('/api/v1/devices')
      .set(bearer(accessToken))
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.device).toMatchObject({
      _id: expect.any(String),
      status: 'active',
    });
    expect(first.body.ingestToken).toEqual(expect.any(String));

    const again = await request(testServer())
      .post('/api/v1/devices')
      .set(bearer(accessToken))
      .send(body);
    expect(again.status).toBe(200);
    expect(again.body.device._id).toBe(first.body.device._id);

    // the native uploader's check-in, with the token the app stored
    const beat = await request(testServer())
      .post('/api/v1/evidence/heartbeat')
      .set('X-Device-Token', again.body.ingestToken);
    expect(beat.status).toBe(200);

    // sign-out kills the token
    const revoked = await request(testServer())
      .delete(`/api/v1/devices/${first.body.device._id}/token`)
      .set(bearer(accessToken));
    expect(revoked.status).toBe(204);
    const afterRevoke = await request(testServer())
      .post('/api/v1/evidence/heartbeat')
      .set('X-Device-Token', again.body.ingestToken);
    expect(afterRevoke.status).toBe(401);
  });

  it('invites, lists and removes a buddy; lists invites and people protected', async () => {
    const owner = await registerUser();

    const invited = await request(testServer())
      .post('/api/v1/buddies')
      .set(bearer(owner.accessToken))
      .send({ email: 'grace@tambo.app', name: 'Grace' });
    expect(invited.status).toBe(201);
    expect(invited.body.buddy).toMatchObject({
      id: expect.any(String),
      email: 'grace@tambo.app',
      status: 'pending',
    });

    const listed = await request(testServer())
      .get('/api/v1/buddies')
      .set(bearer(owner.accessToken));
    expect(listed.status).toBe(200);
    expect(listed.body.buddies[0]).toMatchObject({
      id: invited.body.buddy.id,
      status: 'pending',
    });

    const invites = await request(testServer())
      .get('/api/v1/buddy-invites')
      .set(bearer(owner.accessToken));
    expect(invites.status).toBe(200);
    expect(invites.body.invites).toEqual([]);

    const protecting = await request(testServer())
      .get('/api/v1/protecting')
      .set(bearer(owner.accessToken));
    expect(protecting.status).toBe(200);
    expect(protecting.body.people).toEqual([]);

    const removed = await request(testServer())
      .delete(`/api/v1/buddies/${invited.body.buddy.id}`)
      .set(bearer(owner.accessToken));
    expect(removed.status).toBe(204);
  });
});

describe('legal gate on enrolment for the published app', () => {
  const body = {
    name: 'Tecno Spark',
    make: 'Tecno',
    deviceModel: 'Spark 20',
    installId: 'a1b2c3d4-0000-4000-8000-000000000002',
  };
  const enrolAs = (token: string, platform?: string) => {
    const req = request(testServer())
      .post('/api/v1/devices')
      .set(bearer(token));
    if (platform) req.set('X-Client-Platform', platform);
    return req.send(body);
  };

  afterEach(() => {
    config.legacyClients.legalExempt = true;
  });

  it('lets a header-less build enrol without a recorded acceptance', async () => {
    const { accessToken } = await registerUser(undefined, {
      acceptLegal: false,
    });
    expect((await enrolAs(accessToken)).status).toBe(201);
  });

  it('still gates a current client that sends X-Client-Platform', async () => {
    const { accessToken } = await registerUser(undefined, {
      acceptLegal: false,
    });
    const res = await enrolAs(accessToken, 'android');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('legal_acceptance_required');
  });

  it('gates the legacy build too once the flag is switched off', async () => {
    config.legacyClients.legalExempt = false;
    const { accessToken } = await registerUser(undefined, {
      acceptLegal: false,
    });
    const res = await enrolAs(accessToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('legal_acceptance_required');
  });
});
