import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import PackDelivery from '../src/models/packDelivery.model';
import PushToken from '../src/models/pushToken.model';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { noopPusher } from '../src/services/push/noop.push';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
  noopPusher.clear();
});
afterAll(closeTestDb);

const TOKEN_A = 'fcm-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'fcm-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/** Push alerts are a paid entitlement; fan-out tests run on a pro account. */
const upgradeToPro = (userId: string) =>
  User.updateOne({ _id: userId }, { $set: { plan: 'pro' } });

const registerToken = (accessToken: string, token: string, platform = 'android') =>
  request(testServer())
    .post('/api/v1/push-tokens')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ token, platform });

const enrolAndSteal = async (accessToken: string) => {
  const enrolled = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ name: 'P', imeis: ['356938035643809'], make: 'T', deviceModel: 'S' });
  const deviceId = enrolled.body.device._id as string;
  await request(testServer())
    .post(`/api/v1/devices/${deviceId}/mark-stolen`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({});
  return deviceId;
};

/** Alerts are fire-and-forget: poll for the expected outcome. */
const until = async (predicate: () => Promise<boolean> | boolean) => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met within timeout');
};

describe('POST /api/v1/push-tokens', () => {
  it('requires auth', async () => {
    const res = await request(testServer())
      .post('/api/v1/push-tokens')
      .send({ token: TOKEN_A, platform: 'android' });
    expect(res.status).toBe(401);
  });

  it('upserts idempotently: re-registering bumps lastSeenAt, never duplicates', async () => {
    const { accessToken, userId } = await registerUser();

    const first = await registerToken(accessToken, TOKEN_A);
    expect(first.status).toBe(200);
    const before = new Date(first.body.pushToken.lastSeenAt).getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await registerToken(accessToken, TOKEN_A);
    expect(second.status).toBe(200);
    expect(
      new Date(second.body.pushToken.lastSeenAt).getTime(),
    ).toBeGreaterThanOrEqual(before);

    expect(await PushToken.countDocuments({ user: userId })).toBe(1);
  });

  it('reassigns a token that changes accounts - the old owner stops receiving', async () => {
    const alice = await registerUser();
    await registerToken(alice.accessToken, TOKEN_A);

    const bob = await registerUser({ email: 'bob@tambo.app' });
    await registerToken(bob.accessToken, TOKEN_A);

    expect(await PushToken.countDocuments({ token: TOKEN_A })).toBe(1);
    const row = await PushToken.findOne({ token: TOKEN_A });
    expect(row?.user.toString()).toBe(bob.userId);
  });

  it('caps tokens per user, evicting the least-recently-seen', async () => {
    const { accessToken, userId } = await registerUser();
    for (let i = 0; i < config.push.maxTokensPerUser; i += 1) {
      await registerToken(accessToken, `fcm-token-cap-${i}-xxxxxxxxxxxxxxx`);
    }
    // freshen token 0 so token 1 is the stalest
    await registerToken(accessToken, 'fcm-token-cap-0-xxxxxxxxxxxxxxx');
    await registerToken(accessToken, 'fcm-token-one-over-xxxxxxxxxxxxxxx');

    expect(await PushToken.countDocuments({ user: userId })).toBe(
      config.push.maxTokensPerUser,
    );
    expect(
      await PushToken.exists({ token: 'fcm-token-cap-1-xxxxxxxxxxxxxxx' }),
    ).toBeNull();
    expect(
      await PushToken.exists({ token: 'fcm-token-cap-0-xxxxxxxxxxxxxxx' }),
    ).not.toBeNull();
  });

  it('DELETE unregisters idempotently and never touches other accounts', async () => {
    const alice = await registerUser();
    await registerToken(alice.accessToken, TOKEN_A);

    const mallory = await registerUser({ email: 'mallory@tambo.app' });
    const foreign = await request(testServer())
      .delete('/api/v1/push-tokens')
      .set('Authorization', `Bearer ${mallory.accessToken}`)
      .send({ token: TOKEN_A });
    expect(foreign.status).toBe(204); // quiet no-op, reveals nothing
    expect(await PushToken.exists({ token: TOKEN_A })).not.toBeNull();

    const own = await request(testServer())
      .delete('/api/v1/push-tokens')
      .set('Authorization', `Bearer ${alice.accessToken}`)
      .send({ token: TOKEN_A });
    expect(own.status).toBe(204);
    expect(await PushToken.exists({ token: TOKEN_A })).toBeNull();
  });
});

describe('first-alert push fan-out', () => {
  it('claims once per human and multicasts to all their devices', async () => {
    const { accessToken, userId } = await registerUser();
    await upgradeToPro(userId);
    await registerToken(accessToken, TOKEN_A);
    await registerToken(accessToken, TOKEN_B, 'web');

    await enrolAndSteal(accessToken);

    await until(() => noopPusher.sent.length >= 1);
    expect(noopPusher.sent).toHaveLength(1);
    expect(noopPusher.sent[0]!.tokens.sort()).toEqual([TOKEN_A, TOKEN_B].sort());
    expect(noopPusher.sent[0]!.title).toContain('may be stolen');
    expect(noopPusher.sent[0]!.data?.type).toBe('first_alert');
    // lock-screen payloads carry no IMEIs
    expect(JSON.stringify(noopPusher.sent[0])).not.toContain('356938035643809');

    expect(
      await PackDelivery.countDocuments({
        kind: 'first_alert',
        channel: 'push',
        recipient: `push:${userId}`,
      }),
    ).toBe(1);
  });

  it('email and push claims are independent; converging openers still push once', async () => {
    const { accessToken, userId } = await registerUser();
    await upgradeToPro(userId);
    await registerToken(accessToken, TOKEN_A);
    const deviceId = await enrolAndSteal(accessToken);

    await until(async () =>
      (await PackDelivery.countDocuments({ kind: 'first_alert' })) >= 2,
    );

    // a converging second mark-stolen must not re-alert on any channel
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = await PackDelivery.find({ kind: 'first_alert' });
    const channels = rows.map((row) => row.channel).sort();
    expect(channels).toEqual(['email', 'push']);
    expect(rows.find((row) => row.channel === 'push')?.recipient).toBe(
      `push:${userId}`,
    );
    expect(noopPusher.sent).toHaveLength(1);
  });

  it('degrades silently to email-only when the user has no tokens', async () => {
    const { accessToken, userId } = await registerUser();
    await upgradeToPro(userId);
    await enrolAndSteal(accessToken);

    await until(() =>
      noopMailer.sent.some((mail) => mail.subject.includes('may be stolen')),
    );
    expect(noopPusher.sent).toHaveLength(0);
    expect(
      await PackDelivery.countDocuments({ channel: 'push' }),
    ).toBe(0);
  });

  it('never pushes for a free-plan account - real-time alerts are a paid entitlement', async () => {
    const { accessToken } = await registerUser(); // default plan: free
    await registerToken(accessToken, TOKEN_A);
    await enrolAndSteal(accessToken);

    await until(() =>
      noopMailer.sent.some((mail) => mail.subject.includes('may be stolen')),
    );
    expect(noopPusher.sent).toHaveLength(0); // email still went out above
    expect(await PackDelivery.countDocuments({ channel: 'push' })).toBe(0);
  });

  it('prunes tokens the provider reports dead', async () => {
    const { accessToken, userId } = await registerUser();
    await upgradeToPro(userId);
    await registerToken(accessToken, TOKEN_A);
    await registerToken(accessToken, TOKEN_B);
    noopPusher.failNext = [TOKEN_B];

    await enrolAndSteal(accessToken);

    await until(async () => (await PushToken.exists({ token: TOKEN_B })) === null);
    expect(await PushToken.exists({ token: TOKEN_A })).not.toBeNull();
  });
});

describe('full-pack push nudge', () => {
  it('sends a nudge (no attachment) and records the audit row', async () => {
    const { accessToken, userId } = await registerUser();
    await upgradeToPro(userId);
    await registerToken(accessToken, TOKEN_A);
    const deviceId = await enrolAndSteal(accessToken);
    await until(() => noopPusher.sent.length >= 1); // drain the first alert
    noopPusher.clear();

    const episodes = await request(testServer())
      .get('/api/v1/episodes')
      .set('Authorization', `Bearer ${accessToken}`);
    const episodeId = episodes.body.episodes[0]._id as string;

    const sent = await request(testServer())
      .post(`/api/v1/episodes/${episodeId}/send-pack`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(sent.status).toBe(200);

    await until(() => noopPusher.sent.length >= 1);
    const nudge = noopPusher.sent[0]!;
    expect(nudge.title).toContain('Evidence pack ready');
    expect(nudge.data?.type).toBe('full_pack');
    expect(JSON.stringify(nudge)).not.toContain('base64');

    expect(
      await PackDelivery.countDocuments({
        kind: 'full_pack',
        channel: 'push',
        recipient: `push:${userId}`,
      }),
    ).toBe(1);
    expect(deviceId).toBeTruthy();
  });
});
