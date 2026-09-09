import request from 'supertest';
import { testServer } from '../setup/testServer';
import config from '../../src/config/config';
import { noopMailer } from '../../src/services/mailer/noop.mailer';
import { retryPhantom } from './http';

export const CREDENTIALS = {
  name: 'Ada Lovelace',
  email: 'Ada@Tambo.app',
  password: 'correct-horse-battery',
};

/** Normalized form the API stores and returns. */
export const EMAIL = CREDENTIALS.email.toLowerCase();

export interface Registered {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** Pulls the 6-digit code out of the most recent mail the noop driver captured. */
export const latestOtpCode = (): string => {
  const mail = noopMailer.sent.at(-1);
  if (!mail) throw new Error('no OTP mail captured');
  const match = /code is: (\d{6})/.exec(mail.text);
  if (!match?.[1]) throw new Error(`no code in mail body: ${mail.text}`);
  return match[1];
};

export const verifyOtp = (challengeId: string, code: string) =>
  request(testServer())
    .post('/api/auth/otp/verify')
    .send({ challengeId, code });

/** Returns the raw registration response. */
export const startRegister = (overrides: Partial<typeof CREDENTIALS> = {}) =>
  request(testServer())
    .post('/api/auth/register')
    .send({ ...CREDENTIALS, ...overrides });

export const startSignupChallenge = async () => {
  const registration = await startRegister();
  if (registration.status !== 201 || !registration.body.challenge) {
    throw new Error('could not create signup challenge fixture');
  }
  return { body: { challenge: registration.body.challenge } };
};

/** Returns the raw login response. */
export const startLogin = (
  email = CREDENTIALS.email,
  password = CREDENTIALS.password,
) => request(testServer()).post('/api/auth/login').send({ email, password });

/** Accepts the current version of both legal documents for a session. */
export const acceptLegalDocs = async (accessToken: string): Promise<void> => {
  for (const doc of ['terms', 'privacy'] as const) {
    const res = await request(testServer())
      .post('/api/v1/legal/accept')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ doc, version: config.legal[doc].version, scrolledToEnd: true });
    if (res.status !== 200) {
      throw new Error(
        `acceptLegalDocs failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }
};

/**
 * Full signup: register, complete the signup OTP (the code is pulled from the
 * captured mail), and return the session the verify step issues. Accepts the
 * legal documents by default (device enrolment is gated on them); pass
 * `acceptLegal: false` to get a user who has NOT accepted.
 */
export const registerUser = async (
  overrides: Partial<typeof CREDENTIALS> = {},
  { acceptLegal = true }: { acceptLegal?: boolean } = {},
): Promise<Registered> => {
  const res = await retryPhantom(() => startRegister(overrides), 'register');
  if (res.status !== 201 || !res.body.challenge) {
    throw new Error(
      `registerUser failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  const verified = await retryPhantom(
    () => verifyOtp(res.body.challenge.challengeId, latestOtpCode()),
    'verify signup otp',
  );
  if (verified.status !== 200) {
    throw new Error(
      `registerUser verify failed: ${verified.status} ${JSON.stringify(verified.body)}`,
    );
  }

  if (acceptLegal) await acceptLegalDocs(verified.body.tokens.accessToken);

  return {
    accessToken: verified.body.tokens.accessToken,
    refreshToken: verified.body.tokens.refreshToken,
    userId: verified.body.user._id,
  };
};

/** Full password login. Returns a live session. */
export const loginUser = async (
  email = CREDENTIALS.email,
  password = CREDENTIALS.password,
): Promise<Registered> => {
  const res = await retryPhantom(() => startLogin(email, password), 'login');
  if (res.status !== 200) {
    throw new Error(
      `loginUser failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  return {
    accessToken: res.body.tokens.accessToken,
    refreshToken: res.body.tokens.refreshToken,
    userId: res.body.user._id,
  };
};
