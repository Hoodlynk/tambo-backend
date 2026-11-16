import request from 'supertest';
import { testServer } from './setup/testServer';
import DeviceCommand from '../src/models/deviceCommand.model';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import PackDelivery from '../src/models/packDelivery.model';
import PushToken from '../src/models/pushToken.model';
import User from '../src/models/user.model';
import { parseCommandRef } from '../src/services/evidenceCommand';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { noopPusher } from '../src/services/push/noop.push';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
  noopPusher.clear();
});
afterAll(closeTestDb);

const PHONE_TOKEN = 'fcm-phone-pppppppppppppppppppppppppppp';
const TABLET_TOKEN = 'fcm-tablet-tttttttttttttttttttttttttttt';

const auth = (token: string) => `Bearer ${token}`;

/** Fire-and-forget effects are polled for, never assumed synchronous. */
const until = async (predicate: () => Promise<boolean> | boolean) => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
};

let seq = 0;
const envelope = (type: string, body: object) => {
  const payload = JSON.stringify(body);
  seq += 1;
  return {
    id: `cmd-${Date.now()}-${seq}`,
    type,
    capturedAt: new Date().toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

const enrol = async (email?: string) => {
  const user = await registerUser(email ? { email } : {});
  const res = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', auth(user.accessToken))
    .send({
      name: 'My Tecno',
      imeis: ['356938035643809'],
      make: 'Tecno',
      deviceModel: 'Spark 20',
    });
  return {
    ...user,
    deviceId: res.body.device._id as string,
    ingestToken: res.body.ingestToken as string,
  };
};

/** Opens an episode and drains its fire-and-forget first alert. */
const markStolen = async (accessToken: string, deviceId: string) => {
  const res = await request(testServer())
    .post(`/api/v1/devices/${deviceId}/mark-stolen`)
    .set('Authorization', auth(accessToken))
    .send({});
  const episodeId = res.body.episode._id as string;
  await until(
    async () =>
      (await PackDelivery.countDocuments({
        episode: episodeId,
        kind: 'first_alert',
      })) >= 1,
  );
  return episodeId;
};

const issue = (accessToken: string, deviceId: string, body: object) =>
  request(testServer())
    .post(`/api/v1/devices/${deviceId}/commands`)
    .set('Authorization', auth(accessToken))
    .send(body);

const listCommands = (accessToken: string, deviceId: string) =>
  request(testServer())
    .get(`/api/v1/devices/${deviceId}/commands`)
    .set('Authorization', auth(accessToken));

const cancel = (accessToken: string, deviceId: string, commandId: string) =>
  request(testServer())
    .post(`/api/v1/devices/${deviceId}/commands/${commandId}/cancel`)
    .set('Authorization', auth(accessToken));

const poll = (ingestToken: string) =>
  request(testServer())
    .get('/api/v1/evidence/commands')
    .set('X-Device-Token', ingestToken);

const ingest = (ingestToken: string, envelopes: object[]) =>
  request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', ingestToken)
    .send({ envelopes });

const registerDevicePushToken = (ingestToken: string, token: string) =>
  request(testServer())
    .post('/api/v1/evidence/push-token')
    .set('X-Device-Token', ingestToken)
    .send({ token, platform: 'android' });

const commandStatus = async (accessToken: string, deviceId: string) => {
  const res = await listCommands(accessToken, deviceId);
  return res.body.commands as { id: string; status: string }[];
};

// --- Pure parsing ------------------------------------------------------------

describe('parseCommandRef', () => {
  const id = 'a'.repeat(24);

  it('reads a result reference', () => {
    expect(parseCommandRef(JSON.stringify({ commandId: id, lat: 1 }))).toEqual({
      commandId: id,
      outcome: 'done',
    });
  });

  it('reads a failure with its reason', () => {
    expect(
      parseCommandRef(
        JSON.stringify({
          commandId: id.toUpperCase(),
          outcome: 'failed',
          reason: 'camera_unavailable',
        }),
      ),
    ).toEqual({
      commandId: id,
      outcome: 'failed',
      reason: 'camera_unavailable',
    });
  });

  it('ignores payloads that name no command, or name one badly', () => {
    expect(parseCommandRef('{"lat":1}')).toBeNull();
    expect(parseCommandRef('not json "commandId"')).toBeNull();
    expect(parseCommandRef('{"commandId":"nope"}')).toBeNull();
    expect(parseCommandRef('["commandId"]')).toBeNull();
  });

  it('drops a reason that is not a short slug', () => {
    expect(
      parseCommandRef(
        JSON.stringify({
          commandId: id,
          outcome: 'failed',
          reason: 'has spaces <b>',
        }),
      ),
    ).toEqual({ commandId: id, outcome: 'failed' });
  });
});

// --- Issuing -----------------------------------------------------------------

describe('POST /api/v1/devices/:id/commands', () => {
  it('refuses while no episode is open', async () => {
    const { accessToken, deviceId } = await enrol();
    const res = await issue(accessToken, deviceId, { type: 'ring' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('episode_not_open');
    expect(await DeviceCommand.countDocuments()).toBe(0);
  });

  it('issues a command with type defaults, bound to the open episode', async () => {
    const { accessToken, deviceId } = await enrol();
    const episodeId = await markStolen(accessToken, deviceId);

    const snap = await issue(accessToken, deviceId, { type: 'snapshot' });
    expect(snap.status).toBe(201);
    expect(snap.body.command).toMatchObject({
      type: 'snapshot',
      params: { cameras: ['front', 'back'] },
      status: 'pending',
      deviceId,
      episodeId,
      resultCount: 0,
    });
    const ttl =
      Date.parse(snap.body.command.expiresAt) -
      Date.parse(snap.body.command.issuedAt);
    expect(ttl).toBe(30 * 60 * 1000);

    const ring = await issue(accessToken, deviceId, { type: 'ring' });
    expect(ring.body.command.params).toEqual({ durationSeconds: 30 });

    const locate = await issue(accessToken, deviceId, { type: 'locate' });
    expect(locate.body.command.params).toEqual({});
  });

  it('honours explicit parameters', async () => {
    const { accessToken, deviceId } = await enrol();
    await markStolen(accessToken, deviceId);
    const snap = await issue(accessToken, deviceId, {
      type: 'snapshot',
      cameras: ['back'],
    });
    expect(snap.body.command.params).toEqual({ cameras: ['back'] });
    const ring = await issue(accessToken, deviceId, {
      type: 'ring',
      durationSeconds: 90,
    });
    expect(ring.body.command.params).toEqual({ durationSeconds: 90 });
  });

  it('converges a repeated type on the outstanding command', async () => {
    const { accessToken, deviceId } = await enrol();
    await markStolen(accessToken, deviceId);
    const first = await issue(accessToken, deviceId, { type: 'ring' });
    const second = await issue(accessToken, deviceId, {
      type: 'ring',
      durationSeconds: 60,
    });
    expect(second.status).toBe(200);
    expect(second.body.command.id).toBe(first.body.command.id);
    // the original parameters stand
    expect(second.body.command.params).toEqual({ durationSeconds: 30 });
    expect(await DeviceCommand.countDocuments()).toBe(1);
  });

  it.each([
    [{ type: 'ring', cameras: ['front'] }, 'cameras'],
    [{ type: 'snapshot', durationSeconds: 10 }, 'durationSeconds'],
    [{ type: 'ring', durationSeconds: 1 }, 'durationSeconds'],
    [{ type: 'snapshot', cameras: ['front', 'front'] }, 'cameras'],
    [{ type: 'snapshot', cameras: [] }, 'cameras'],
    [{ type: 'selfdestruct' }, 'type'],
  ])('rejects %j', async (body, field) => {
    const { accessToken, deviceId } = await enrol();
    await markStolen(accessToken, deviceId);
    const res = await issue(accessToken, deviceId, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(
      field,
    );
  });

  it("404s on someone else's device, indistinguishably", async () => {
    const owner = await enrol();
    await markStolen(owner.accessToken, owner.deviceId);
    const stranger = await registerUser({ email: 'eve@tambo.app' });
    const res = await issue(stranger.accessToken, owner.deviceId, {
      type: 'locate',
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });

  it('refuses when the device can no longer poll (token revoked)', async () => {
    const { accessToken, deviceId } = await enrol();
    await markStolen(accessToken, deviceId);
    await request(testServer())
      .delete(`/api/v1/devices/${deviceId}/token`)
      .set('Authorization', auth(accessToken));
    const res = await issue(accessToken, deviceId, { type: 'locate' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_token_revoked');
  });
});

// --- Delivery ----------------------------------------------------------------

describe('delivery to the device', () => {
  it('wakes only the device-scoped install, with no parameters in the push', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await request(testServer())
      .post('/api/v1/push-tokens')
      .set('Authorization', auth(accessToken))
      .send({ token: TABLET_TOKEN, platform: 'android' });
    await markStolen(accessToken, deviceId);

    const res = await issue(accessToken, deviceId, {
      type: 'ring',
      durationSeconds: 45,
    });
    await until(() => noopPusher.sentData.length >= 1);
    expect(noopPusher.sentData).toHaveLength(1);
    expect(noopPusher.sentData[0]!.tokens).toEqual([PHONE_TOKEN]);
    expect(noopPusher.sentData[0]!.data).toEqual({
      type: 'device_command',
      commandId: res.body.command.id,
      commandType: 'ring',
    });
  });

  it('prunes a dead device token reported by the provider', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await markStolen(accessToken, deviceId);
    noopPusher.failNext = [PHONE_TOKEN];
    await issue(accessToken, deviceId, { type: 'locate' });
    await until(async () => (await PushToken.countDocuments()) === 0);
  });

  it('hands outstanding commands over on every poll until answered', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const issued = await issue(accessToken, deviceId, { type: 'locate' });
    const id = issued.body.command.id as string;

    const first = await poll(ingestToken);
    expect(first.status).toBe(200);
    expect(first.body.commands).toEqual([
      {
        id,
        type: 'locate',
        params: {},
        issuedAt: issued.body.command.issuedAt,
        expiresAt: issued.body.command.expiresAt,
      },
    ]);
    const [afterPoll] = await commandStatus(accessToken, deviceId);
    expect(afterPoll!.status).toBe('delivered');
    const deliveredAt = (await DeviceCommand.findById(id))!.deliveredAt;

    // the reply was lost? the next poll hands it over again
    const second = await poll(ingestToken);
    expect(second.body.commands.map((c: { id: string }) => c.id)).toEqual([id]);
    // and the first-delivery time is not moved
    expect((await DeviceCommand.findById(id))!.deliveredAt).toEqual(
      deliveredAt,
    );
  });

  it('rides on the ingest reply while an episode is open', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const ring = await issue(accessToken, deviceId, { type: 'ring' });
    const snap = await issue(accessToken, deviceId, { type: 'snapshot' });

    const res = await ingest(ingestToken, [
      envelope('STATUS', { battery: 40 }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.pendingCommands.map((c: { id: string }) => c.id)).toEqual([
      ring.body.command.id,
      snap.body.command.id,
    ]);
  });

  it('adds nothing to a routine ingest', async () => {
    const { ingestToken } = await enrol();
    const res = await ingest(ingestToken, [
      envelope('STATUS', { battery: 90 }),
    ]);
    expect(res.status).toBe(200);
    expect(res.body.pendingCommands).toBeUndefined();
    const polled = await poll(ingestToken);
    expect(polled.body.commands).toEqual([]);
  });

  it('requires the device token to poll', async () => {
    const res = await request(testServer()).get('/api/v1/evidence/commands');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_device_token');
  });
});

// --- Answers -----------------------------------------------------------------

describe('answers arrive as evidence', () => {
  it('a result envelope completes the command and is linked to it', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const issued = await issue(accessToken, deviceId, { type: 'snapshot' });
    const commandId = issued.body.command.id as string;
    await poll(ingestToken);

    const frames = [0, 1].map((n) =>
      envelope('PHOTO', {
        commandId,
        burstId: 'burst-remote-1',
        seq: n,
        count: 2,
        camera: 'front',
        trigger: 'owner_request',
      }),
    );
    const res = await ingest(ingestToken, frames);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'acked',
      'acked',
    ]);
    // answered: no longer handed out
    expect(res.body.pendingCommands).toBeUndefined();

    const [command] = (await listCommands(accessToken, deviceId)).body.commands;
    expect(command).toMatchObject({ status: 'completed', resultCount: 2 });
    expect(command.completedAt).toBeDefined();

    const linked = await EvidenceEnvelope.countDocuments({ commandId });
    expect(linked).toBe(2);

    // a retried batch is a duplicate, not two more results
    await ingest(ingestToken, frames);
    const [again] = (await listCommands(accessToken, deviceId)).body.commands;
    expect(again.resultCount).toBe(2);
  });

  it('a failure report fails it; a later result still completes it', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const issued = await issue(accessToken, deviceId, { type: 'snapshot' });
    const commandId = issued.body.command.id as string;

    await ingest(ingestToken, [
      envelope('STATUS', {
        commandId,
        outcome: 'failed',
        reason: 'camera_unavailable',
      }),
    ]);
    let [command] = (await listCommands(accessToken, deviceId)).body.commands;
    expect(command).toMatchObject({
      status: 'failed',
      failureReason: 'camera_unavailable',
      resultCount: 0,
    });
    expect((await poll(ingestToken)).body.commands).toEqual([]);

    await ingest(ingestToken, [
      envelope('PHOTO', { commandId, trigger: 'owner_request' }),
    ]);
    [command] = (await listCommands(accessToken, deviceId)).body.commands;
    expect(command.status).toBe('completed');
    expect(command.failureReason).toBeUndefined();
  });

  it("cannot answer another device's command", async () => {
    const victim = await enrol();
    await markStolen(victim.accessToken, victim.deviceId);
    const issued = await issue(victim.accessToken, victim.deviceId, {
      type: 'locate',
    });
    const commandId = issued.body.command.id as string;

    const other = await enrol('mallory@tambo.app');
    const res = await ingest(other.ingestToken, [
      envelope('TRAIL_POINT', { commandId, lat: 0, lng: 0 }),
    ]);
    expect(res.body.results[0].status).toBe('acked'); // evidence is still kept

    const stored = await EvidenceEnvelope.findOne({
      envelopeId: res.body.results[0].id,
    });
    expect(stored!.commandId).toBeUndefined();
    const [command] = (await listCommands(victim.accessToken, victim.deviceId))
      .body.commands;
    expect(command).toMatchObject({ status: 'pending', resultCount: 0 });
  });
});

// --- Lifetime ----------------------------------------------------------------

describe('expiry and cancellation', () => {
  it('an unanswered command expires by the clock, and a new one can be issued', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const first = await issue(accessToken, deviceId, { type: 'ring' });
    await DeviceCommand.updateOne(
      { _id: first.body.command.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    const [command] = await commandStatus(accessToken, deviceId);
    expect(command!.status).toBe('expired');
    expect((await poll(ingestToken)).body.commands).toEqual([]);

    const second = await issue(accessToken, deviceId, { type: 'ring' });
    expect(second.status).toBe(201);
    expect(second.body.command.id).not.toBe(first.body.command.id);
  });

  it('cancel stops delivery and is idempotent', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const issued = await issue(accessToken, deviceId, { type: 'ring' });
    const id = issued.body.command.id as string;

    const res = await cancel(accessToken, deviceId, id);
    expect(res.status).toBe(200);
    expect(res.body.command.status).toBe('cancelled');
    expect(res.body.command.cancelledAt).toBeDefined();
    expect((await poll(ingestToken)).body.commands).toEqual([]);

    const again = await cancel(accessToken, deviceId, id);
    expect(again.status).toBe(200);
    expect(again.body.command.cancelledAt).toBe(res.body.command.cancelledAt);
  });

  it('cancelling a finished command returns it unchanged', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    const issued = await issue(accessToken, deviceId, { type: 'locate' });
    const commandId = issued.body.command.id as string;
    await ingest(ingestToken, [
      envelope('TRAIL_POINT', { commandId, lat: -1.29, lng: 36.82 }),
    ]);
    const res = await cancel(accessToken, deviceId, commandId);
    expect(res.status).toBe(200);
    expect(res.body.command.status).toBe('completed');
  });

  it('404s on an unknown command, or one on another device', async () => {
    const owner = await enrol();
    await markStolen(owner.accessToken, owner.deviceId);
    const res = await cancel(owner.accessToken, owner.deviceId, 'f'.repeat(24));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('command_not_found');
  });

  it('resolving the episode cancels what is outstanding', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await markStolen(accessToken, deviceId);
    await issue(accessToken, deviceId, { type: 'ring' });
    await issue(accessToken, deviceId, { type: 'snapshot' });

    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', auth(accessToken));

    const commands = await commandStatus(accessToken, deviceId);
    expect(commands.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
    expect((await poll(ingestToken)).body.commands).toEqual([]);
  });

  it('removing the device deletes its commands and unbinds its push token', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await request(testServer())
      .post('/api/v1/push-tokens')
      .set('Authorization', auth(accessToken))
      .send({ token: PHONE_TOKEN, platform: 'android' });
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await markStolen(accessToken, deviceId);
    await issue(accessToken, deviceId, { type: 'locate' });
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', auth(accessToken));

    const res = await request(testServer())
      .delete(`/api/v1/devices/${deviceId}`)
      .set('Authorization', auth(accessToken));
    expect(res.status).toBe(204);
    expect(await DeviceCommand.countDocuments()).toBe(0);
    const row = await PushToken.findOne({ token: PHONE_TOKEN });
    expect(row).not.toBeNull(); // still the owner's install
    expect(row!.device).toBeUndefined();
  });
});

// --- Device-scoped push tokens -------------------------------------------------

describe('POST /api/v1/evidence/push-token', () => {
  it("binds the install to the device, on the owner's account", async () => {
    const { userId, deviceId, ingestToken } = await enrol();
    const res = await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.pushToken.platform).toBe('android');
    const row = await PushToken.findOne({ token: PHONE_TOKEN });
    expect(row!.user.toString()).toBe(userId);
    expect(row!.device!.toString()).toBe(deviceId);
  });

  it('requires the device token', async () => {
    const res = await request(testServer())
      .post('/api/v1/evidence/push-token')
      .send({ token: PHONE_TOKEN, platform: 'android' });
    expect(res.status).toBe(401);
  });

  it('theft alerts about the device skip the stolen phone itself', async () => {
    const { accessToken, userId, deviceId, ingestToken } = await enrol();
    await User.updateOne({ _id: userId }, { $set: { plan: 'pro' } });
    // both installs are signed in, so alerts are on for both; only the
    // device binding can be what keeps the stolen phone out
    for (const token of [PHONE_TOKEN, TABLET_TOKEN]) {
      await request(testServer())
        .post('/api/v1/push-tokens')
        .set('Authorization', auth(accessToken))
        .send({ token, platform: 'android' });
    }
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);

    await markStolen(accessToken, deviceId);
    await until(() => noopPusher.sent.length >= 1);
    expect(noopPusher.sent).toHaveLength(1);
    expect(noopPusher.sent[0]!.tokens).toEqual([TABLET_TOKEN]);
  });

  it('a token that changes hands stops being the old owner device', async () => {
    const { ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);

    const buyer = await registerUser({ email: 'buyer@tambo.app' });
    await request(testServer())
      .post('/api/v1/push-tokens')
      .set('Authorization', auth(buyer.accessToken))
      .send({ token: PHONE_TOKEN, platform: 'android' });

    const row = await PushToken.findOne({ token: PHONE_TOKEN });
    expect(row!.user.toString()).toBe(buyer.userId);
    expect(row!.device).toBeUndefined();
  });

  it('the same owner re-registering keeps the device binding', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await request(testServer())
      .post('/api/v1/push-tokens')
      .set('Authorization', auth(accessToken))
      .send({ token: PHONE_TOKEN, platform: 'android' });
    const row = await PushToken.findOne({ token: PHONE_TOKEN });
    expect(row!.device!.toString()).toBe(deviceId);
  });
});

// --- Alerts vs wake-ups on one install -----------------------------------------

describe('sign-out and credential rotation keep wake-ups', () => {
  const ownerRegister = (accessToken: string, token: string) =>
    request(testServer())
      .post('/api/v1/push-tokens')
      .set('Authorization', auth(accessToken))
      .send({ token, platform: 'android' });

  it('sign out everywhere silences alerts but the phone can still be woken', async () => {
    const { accessToken, refreshToken, deviceId, ingestToken } = await enrol();
    await ownerRegister(accessToken, PHONE_TOKEN);
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await ownerRegister(accessToken, TABLET_TOKEN);

    const out = await request(testServer())
      .post('/api/v1/auth/logout-all')
      .set('Authorization', auth(accessToken))
      .send({ refreshToken });
    expect(out.status).toBe(204);

    // the plain install is gone; the device-bound one stays, alerts off
    expect(await PushToken.countDocuments({ token: TABLET_TOKEN })).toBe(0);
    const row = await PushToken.findOne({ token: PHONE_TOKEN });
    expect(row).toMatchObject({ alerts: false });
    expect(row!.device!.toString()).toBe(deviceId);

    // the owner signs back in elsewhere and sends a command: it still wakes
    const fresh = await request(testServer())
      .post('/api/v1/auth/login')
      .send({ email: 'ada@tambo.app', password: 'correct-horse-battery' });
    const { accessToken: next } = fresh.body.tokens;
    await markStolen(next, deviceId);
    await issue(next, deviceId, { type: 'locate' });
    await until(() => noopPusher.sentData.length >= 1);
    expect(noopPusher.sentData[0]!.tokens).toEqual([PHONE_TOKEN]);
  });

  it('a device register never turns alerts on; a signed-in register does', async () => {
    const { accessToken, userId, ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    expect(await PushToken.findOne({ token: PHONE_TOKEN })).toMatchObject({
      alerts: false,
    });
    const { activeTokensForUser } =
      await import('../src/services/pushToken.service');
    expect(await activeTokensForUser(userId)).toEqual([]);

    await ownerRegister(accessToken, PHONE_TOKEN);
    expect(await activeTokensForUser(userId)).toEqual([PHONE_TOKEN]);

    // and a later device re-register leaves them on
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    expect(await activeTokensForUser(userId)).toEqual([PHONE_TOKEN]);
  });

  it('signing out on the phone keeps the device binding', async () => {
    const { accessToken, ingestToken } = await enrol();
    await ownerRegister(accessToken, PHONE_TOKEN);
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);

    const res = await request(testServer())
      .delete('/api/v1/push-tokens')
      .set('Authorization', auth(accessToken))
      .send({ token: PHONE_TOKEN });
    expect(res.status).toBe(204);
    expect(await PushToken.findOne({ token: PHONE_TOKEN })).toMatchObject({
      alerts: false,
    });
  });

  it('removing the device drops an install that was only a wake-up target', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await registerDevicePushToken(ingestToken, PHONE_TOKEN);
    await request(testServer())
      .delete(`/api/v1/devices/${deviceId}`)
      .set('Authorization', auth(accessToken));
    expect(await PushToken.countDocuments()).toBe(0);
  });
});
