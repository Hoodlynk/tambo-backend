import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import OtpChallenge from '../src/models/otpChallenge.model';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import * as otpService from '../src/services/otp.service';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import {
  CREDENTIALS,
  EMAIL,
  latestOtpCode,
  registerUser,
  startLogin,
  startSignupChallenge,
  verifyOtp,
} from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

/** A code guaranteed wrong: flips the last digit of the real one. */
const wrongCode = (real: string): string =>
  real.slice(0, 5) + String((Number(real[5]) + 1) % 10);

describe('OTP mail', () => {
  it('emails a 6-digit code to the registered address on signup', async () => {
    await startSignupChallenge();

    const mail = noopMailer.sent.at(-1);
    expect(mail?.to).toBe(EMAIL);
    expect(mail?.subject).toContain('Verify');
    expect(latestOtpCode()).toMatch(/^\d{6}$/);
  });

  it('stores only a hash of the code, never the code itself', async () => {
    await startSignupChallenge();
    const code = latestOtpCode();

    const challenge = await OtpChallenge.findOne({});
    expect(challenge?.codeHash).toBeTruthy();
    expect(challenge?.codeHash).not.toContain(code);
    expect(JSON.stringify(challenge?.toObject())).not.toContain(code);
  });
});

describe('code verification', () => {
  it('rejects a wrong code without consuming the challenge', async () => {
    const res = await startSignupChallenge();
    const code = latestOtpCode();

    const wrong = await verifyOtp(
      res.body.challenge.challengeId,
      wrongCode(code),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('invalid_otp');

    // the real code still works afterwards
    expect((await verifyOtp(res.body.challenge.challengeId, code)).status).toBe(
      200,
    );
  });

  it('burns the challenge after maxAttempts wrong guesses - even for the real code', async () => {
    const res = await startSignupChallenge();
    const code = latestOtpCode();
    const { challengeId } = res.body.challenge;

    for (let i = 0; i < config.otp.maxAttempts - 1; i += 1) {
      expect((await verifyOtp(challengeId, wrongCode(code))).status).toBe(401);
    }
    const last = await verifyOtp(challengeId, wrongCode(code));
    expect(last.body.code).toBe('otp_attempts_exceeded');

    const real = await verifyOtp(challengeId, code);
    expect(real.status).toBe(401);
    expect(real.body.code).toBe('invalid_challenge');
  });

  it('is single-use: a consumed challenge cannot be verified again', async () => {
    const res = await startSignupChallenge();
    const code = latestOtpCode();

    expect((await verifyOtp(res.body.challenge.challengeId, code)).status).toBe(
      200,
    );

    const replay = await verifyOtp(res.body.challenge.challengeId, code);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('invalid_challenge');
  });

  it('lets exactly one winner through under concurrent submission', async () => {
    const res = await startSignupChallenge();
    const code = latestOtpCode();

    const results = await Promise.all([
      verifyOtp(res.body.challenge.challengeId, code),
      verifyOtp(res.body.challenge.challengeId, code),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects an expired challenge', async () => {
    const res = await startSignupChallenge();
    const code = latestOtpCode();
    await OtpChallenge.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const expired = await verifyOtp(res.body.challenge.challengeId, code);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe('invalid_challenge');
  });

  it('a new challenge for the same purpose burns the previous one', async () => {
    const first = await startSignupChallenge();
    const firstCode = latestOtpCode();
    const user = await User.findOne({ email: EMAIL });
    if (!user) throw new Error('registered user not found');
    const second = await otpService.createChallenge(user, 'signup');

    const stale = await verifyOtp(first.body.challenge.challengeId, firstCode);
    expect(stale.status).toBe(401);

    expect((await verifyOtp(second.challengeId, latestOtpCode())).status).toBe(
      200,
    );
  });
});

describe('POST /api/auth/otp/resend', () => {
  const resend = (challengeId: string) =>
    request(testServer()).post('/api/auth/otp/resend').send({ challengeId });

  it('enforces the cooldown with a Retry-After', async () => {
    const res = await startSignupChallenge();

    const tooSoon = await resend(res.body.challenge.challengeId);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.retryAfter).toBeGreaterThan(0);
  });

  it('rotates the code: the old one dies, the new one works', async () => {
    const original = config.otp.resendCooldownSeconds;
    config.otp.resendCooldownSeconds = 0;
    try {
      const res = await startSignupChallenge();
      const oldCode = latestOtpCode();
      const { challengeId } = res.body.challenge;

      expect((await resend(challengeId)).status).toBe(204);
      const newCode = latestOtpCode();
      expect(newCode).not.toBe(oldCode);

      if (oldCode !== newCode) {
        expect((await verifyOtp(challengeId, oldCode)).status).toBe(401);
      }
      expect((await verifyOtp(challengeId, newCode)).status).toBe(200);
    } finally {
      config.otp.resendCooldownSeconds = original;
    }
  });

  it('refuses to resend a consumed or unknown challenge', async () => {
    const res = await startSignupChallenge();
    await verifyOtp(res.body.challenge.challengeId, latestOtpCode());

    const consumed = await resend(res.body.challenge.challengeId);
    expect(consumed.status).toBe(401);
    expect(consumed.body.code).toBe('invalid_challenge');

    const unknown = await resend('a'.repeat(24));
    expect(unknown.status).toBe(401);
  });
});

describe('POST /api/auth/change-email', () => {
  const NEW_EMAIL = 'ada.new@tambo.app';

  const requestChange = async (accessToken: string, newEmail = NEW_EMAIL) =>
    request(testServer())
      .post('/api/auth/change-email')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ newEmail, password: CREDENTIALS.password });

  it('sends the code to the NEW address and applies on verify', async () => {
    const { accessToken, refreshToken } = await registerUser();

    const res = await requestChange(accessToken);
    expect(res.status).toBe(200);
    expect(res.body.challenge.purpose).toBe('email_change');
    expect(noopMailer.sent.at(-1)?.to).toBe(NEW_EMAIL);

    // nothing changed yet
    expect((await User.findOne({ email: EMAIL }))?.email).toBe(EMAIL);

    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.user.email).toBe(NEW_EMAIL);
    expect(verified.body.user.emailVerifiedAt).toBeTruthy();

    // identifier changed: old sessions are gone, new pair works, old email can't log in
    expect(
      (
        await request(testServer())
          .post('/api/auth/refresh')
          .send({ refreshToken })
      ).status,
    ).toBe(401);
    expect((await startLogin(NEW_EMAIL)).status).toBe(200);
    expect((await startLogin(EMAIL)).status).toBe(401);
  });

  it('rejects a wrong password and a taken address', async () => {
    const { accessToken } = await registerUser();
    await registerUser({ email: NEW_EMAIL });

    const wrongPassword = await request(testServer())
      .post('/api/auth/change-email')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ newEmail: 'fresh@tambo.app', password: 'not-my-password' });
    expect(wrongPassword.status).toBe(401);

    const taken = await requestChange(accessToken);
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('email_taken');
  });

  it('fails at verify if the address was claimed while the code was in flight', async () => {
    const { accessToken } = await registerUser();
    const res = await requestChange(accessToken);
    const code = latestOtpCode();

    await registerUser({ email: NEW_EMAIL }); // someone claims it first

    const verified = await verifyOtp(res.body.challenge.challengeId, code);
    expect(verified.status).toBe(409);
    expect(verified.body.code).toBe('email_taken');
  });
});

describe('POST /api/auth/verify-email', () => {
  /** A signed-in account whose mailbox was never proven (pre-OTP legacy). */
  const legacyUnverifiedUser = async () => {
    const session = await registerUser();
    await User.updateOne(
      { _id: session.userId },
      { $unset: { emailVerifiedAt: 1 } },
    );
    noopMailer.clear();
    return session;
  };

  it('requires auth', async () => {
    const res = await request(testServer()).post('/api/auth/verify-email');
    expect(res.status).toBe(401);
  });

  it('opens a signup challenge whose code heals verification', async () => {
    const { accessToken, userId } = await legacyUnverifiedUser();

    const res = await request(testServer())
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.challenge.purpose).toBe('signup');

    const verified = await verifyOtp(
      res.body.challenge.challengeId,
      latestOtpCode(),
    );
    expect(verified.status).toBe(200);
    expect(verified.body.tokens.accessToken).toBeTruthy();

    const user = await User.findById(userId);
    expect(user?.emailVerifiedAt).toBeTruthy();
  });

  it('409s with email_already_verified when there is nothing to do', async () => {
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .post('/api/auth/verify-email')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('email_already_verified');
  });

  it('is served identically on the canonical /api/v1/auth mount', async () => {
    const { accessToken } = await legacyUnverifiedUser();
    const res = await request(testServer())
      .post('/api/v1/auth/verify-email')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.challenge.purpose).toBe('signup');
  });
});
