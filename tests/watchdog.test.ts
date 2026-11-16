import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import AlertActionToken from '../src/models/alertActionToken.model';
import Device from '../src/models/device.model';
import TheftEpisode from '../src/models/theftEpisode.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { sweepQuietDevices } from '../src/services/watchdog.service';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const MINUTE = 60 * 1000;
const INSTALL_ID = 'install-0f3c2a9b';

const enrol = (accessToken: string, body: object = {}) =>
  request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'Tecno Spark 20',
      make: 'Tecno',
      deviceModel: 'Spark 20',
      installId: INSTALL_ID,
      ...body,
    });

let seq = 0;
const envelope = (
  type: string,
  payloadObj: object,
  capturedAt = new Date(),
) => {
  const payload = JSON.stringify(payloadObj);
  seq += 1;
  return {
    id: `wd-${Date.now()}-${seq}`,
    type,
    capturedAt: capturedAt.toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

const failed = (at?: Date) =>
  envelope('UNLOCK_FAILED', { attemptNo: 1, method: 'unknown' }, at);
const unlocked = (at?: Date) =>
  envelope('STATUS', { event: 'UNLOCK_SUCCEEDED' }, at);
const boot = (locked: boolean) => envelope('STATUS', { event: 'BOOT', locked });

const ingest = (token: string, envelopes: object[]) =>
  request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', token)
    .send({ envelopes });

const heartbeat = (token: string) =>
  request(testServer())
    .post('/api/v1/evidence/heartbeat')
    .set('X-Device-Token', token);

const later = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

/** First alerts are fire-and-forget; wait for the mail to land. */
const waitForMail = async (to: string): Promise<void> => {
  for (let i = 0; i < 50; i += 1) {
    if (noopMailer.sent.some((mail) => mail.to === to)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no mail to ${to}`);
};

const setUpEnrolled = async () => {
  const owner = await registerUser();
  const res = await enrol(owner.accessToken);
  noopMailer.clear();
  return {
    owner,
    deviceId: res.body.device._id as string,
    ingestToken: res.body.ingestToken as string,
  };
};

/** Owner Ada with Grace as an ACCEPTED buddy. */
const setUpWithBuddy = async () => {
  const enrolled = await setUpEnrolled();
  const buddy = await registerUser({
    email: 'grace@tambo.app',
    name: 'Grace Hopper',
  });
  await request(testServer())
    .post('/api/v1/buddies')
    .set('Authorization', `Bearer ${enrolled.owner.accessToken}`)
    .send({ email: 'grace@tambo.app' });
  const invites = await request(testServer())
    .get('/api/v1/buddy-invites')
    .set('Authorization', `Bearer ${buddy.accessToken}`);
  await request(testServer())
    .post(`/api/v1/buddy-invites/${invites.body.invites[0].id}/accept`)
    .set('Authorization', `Bearer ${buddy.accessToken}`);
  noopMailer.clear();
  return { ...enrolled, buddy };
};

/** The one-tap link out of the latest quiet alert email. */
const actionPath = (): string => {
  const text = noopMailer.sent.at(-1)?.text ?? '';
  const match = /\/api\/v1\/alert-actions\/[a-f\d]{96}/.exec(text);
  if (!match) throw new Error(`no action link in: ${text}`);
  return match[0];
};

describe('self-enrolment at sign-in', () => {
  it('enrols without IMEIs - the owner adds them later', async () => {
    const owner = await registerUser();
    const res = await enrol(owner.accessToken);

    expect(res.status).toBe(201);
    expect(res.body.device.imeis).toEqual([]);
  });

  it('still rejects an explicitly empty IMEI list', async () => {
    const owner = await registerUser();
    const res = await enrol(owner.accessToken, { imeis: [] });
    expect(res.status).toBe(400);
  });

  it('re-enrolling the same install re-issues the token on the same device', async () => {
    const owner = await registerUser();
    const first = await enrol(owner.accessToken);

    // the owner renamed it and added an IMEI in between
    await request(testServer())
      .patch(`/api/v1/devices/${first.body.device._id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'My phone', imeis: ['356938035643809'] });

    const second = await enrol(owner.accessToken);

    expect(second.status).toBe(200);
    expect(second.body.device._id).toBe(first.body.device._id);
    expect(second.body.ingestToken).not.toBe(first.body.ingestToken);
    // the app's auto-generated values never overwrite what the owner typed
    expect(second.body.device.name).toBe('My phone');
    expect(second.body.device.imeis).toEqual(['356938035643809']);
    expect(await Device.countDocuments()).toBe(1);

    // the old token died with the re-issue
    expect((await heartbeat(first.body.ingestToken)).status).toBe(401);
    expect((await heartbeat(second.body.ingestToken)).status).toBe(200);
  });

  it('the same install under a different account is a different device', async () => {
    const ada = await registerUser();
    const grace = await registerUser({ email: 'grace@tambo.app' });

    const a = await enrol(ada.accessToken);
    const g = await enrol(grace.accessToken);

    expect(g.status).toBe(201);
    expect(g.body.device._id).not.toBe(a.body.device._id);
  });
});

describe('POST /api/v1/evidence/heartbeat', () => {
  it('requires the device token', async () => {
    const res = await request(testServer()).post('/api/v1/evidence/heartbeat');
    expect(res.status).toBe(401);
  });

  it('stamps lastSeenAt', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();

    const res = await heartbeat(ingestToken);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const device = await Device.findById(deviceId);
    expect(device?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('tells the phone when a theft episode is open', async () => {
    const { owner, deviceId, ingestToken } = await setUpEnrolled();
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});

    const res = await heartbeat(ingestToken);
    expect(typeof res.body.episodeId).toBe('string');
  });
});

describe('suspicion tracking on ingest', () => {
  const suspiciousAt = async (deviceId: string) =>
    (await Device.findById(deviceId))?.suspiciousAt;

  it('a failed unlock raises it and counts as contact', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);

    const device = await Device.findById(deviceId);
    expect(device?.suspiciousAt).toBeInstanceOf(Date);
    expect(device?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('a later successful unlock clears it', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    await ingest(ingestToken, [unlocked()]);

    expect(await suspiciousAt(deviceId)).toBeUndefined();
  });

  it('within one batch, device order decides', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    const t0 = new Date(Date.now() - 2 * MINUTE);
    const t1 = new Date(Date.now() - MINUTE);

    // owner mistyped, then got in
    await ingest(ingestToken, [unlocked(t1), failed(t0)]);
    expect(await suspiciousAt(deviceId)).toBeUndefined();

    // got in, then someone else failed
    await ingest(ingestToken, [failed(t1), unlocked(t0)]);
    expect(await suspiciousAt(deviceId)).toBeInstanceOf(Date);
  });

  it('a boot left on the lock screen raises it; an unlocked boot does not', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();

    await ingest(ingestToken, [boot(false)]);
    expect(await suspiciousAt(deviceId)).toBeUndefined();

    await ingest(ingestToken, [boot(true)]);
    expect(await suspiciousAt(deviceId)).toBeInstanceOf(Date);
  });

  it('a re-sent duplicate does not re-apply its effect', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    const fail = failed();
    await ingest(ingestToken, [fail]);
    await ingest(ingestToken, [unlocked()]);

    const retry = await ingest(ingestToken, [fail]);
    expect(retry.body.results[0].status).toBe('duplicate');
    expect(await suspiciousAt(deviceId)).toBeUndefined();
  });

  it('ignores STATUS payloads that are not the watchdog shape', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    const res = await ingest(ingestToken, [
      envelope('STATUS', { battery: 12 }),
    ]);
    expect(res.body.results[0].status).toBe('acked');
    expect(await suspiciousAt(deviceId)).toBeUndefined();
  });
});

describe('the quiet-device sweep', () => {
  const quiet = config.watchdog.quietAfterMinutes;
  const silentMinutes = config.watchdog.silentAfterHours * 60;

  it('alerts the owner - only the owner - when a phone goes quiet after a failed unlock', async () => {
    const { ingestToken } = await setUpWithBuddy();
    await ingest(ingestToken, [failed()]);
    noopMailer.clear();

    expect(await sweepQuietDevices(later(quiet - 1))).toBe(0);
    expect(await sweepQuietDevices(later(quiet + 1))).toBe(1);

    expect(noopMailer.sent).toHaveLength(1);
    const mail = noopMailer.sent[0];
    expect(mail?.to).toBe('ada@tambo.app');
    expect(mail?.subject).toContain(
      'went offline after a failed unlock or restart',
    );
    expect(mail?.text).toContain('/api/v1/alert-actions/');
  });

  it('alerts once per silence, and re-arms after the phone is heard from', async () => {
    const { deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    // age the contact rather than advancing the sweep's clock: the alert is
    // stamped with the sweep's `now`, and the heartbeat below must land
    // AFTER it, as it would in real time
    const past = new Date(Date.now() - (quiet + 1) * MINUTE);
    await Device.updateOne(
      { _id: deviceId },
      { $set: { lastSeenAt: past, suspiciousAt: past } },
    );

    expect(await sweepQuietDevices()).toBe(1);
    expect(await sweepQuietDevices()).toBe(0);

    // back online (still no successful unlock), then silent again
    await heartbeat(ingestToken);
    expect(await sweepQuietDevices(later(quiet + 1))).toBe(1);
  });

  it('stays silent when the failed run ended in a successful unlock', async () => {
    const { ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    await ingest(ingestToken, [unlocked()]);

    expect(await sweepQuietDevices(later(quiet + 1))).toBe(0);
  });

  it('alerts on plain long silence, with no suspicion', async () => {
    const { ingestToken } = await setUpEnrolled();
    await heartbeat(ingestToken);

    expect(await sweepQuietDevices(later(silentMinutes - 1))).toBe(0);
    expect(await sweepQuietDevices(later(silentMinutes + 1))).toBe(1);
    expect(noopMailer.sent.at(-1)?.subject).toContain('has not checked in');
  });

  it('never alerts for a device that has not checked in at all yet', async () => {
    // registered by the owner from elsewhere (no installId): never contact
    const owner = await registerUser();
    await enrol(owner.accessToken, { installId: undefined });
    expect(await sweepQuietDevices(later(silentMinutes * 2))).toBe(0);
  });

  it('counts self-enrolment as contact', async () => {
    const { deviceId } = await setUpEnrolled();
    const device = await Device.findById(deviceId);
    expect(device?.lastSeenAt).toBeInstanceOf(Date);
  });

  it('ignores a device whose token was revoked (signed out on the phone)', async () => {
    const { owner, deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    await request(testServer())
      .delete(`/api/v1/devices/${deviceId}/token`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    expect(await sweepQuietDevices(later(silentMinutes + 1))).toBe(0);
  });

  it('skips a device already marked stolen', async () => {
    const { owner, deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});

    expect(await sweepQuietDevices(later(quiet + 1))).toBe(0);
  });

  it('recovery clears the markers', async () => {
    const { owner, deviceId, ingestToken } = await setUpEnrolled();
    await ingest(ingestToken, [failed()]);
    await sweepQuietDevices(later(quiet + 1));
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({});
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    const device = await Device.findById(deviceId);
    expect(device?.suspiciousAt).toBeUndefined();
    expect(device?.quietAlertedAt).toBeUndefined();
  });
});

describe('the one-tap link in the quiet alert', () => {
  const armLink = async () => {
    const setup = await setUpWithBuddy();
    await ingest(setup.ingestToken, [failed()]);
    await sweepQuietDevices(later(config.watchdog.quietAfterMinutes + 1));
    return { ...setup, path: actionPath() };
  };

  it('GET shows a confirmation page and changes nothing', async () => {
    const { path } = await armLink();

    const res = await request(testServer()).get(path);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Tecno Spark 20');
    expect(res.text).toContain('<form method="post">');
    expect(await TheftEpisode.countDocuments()).toBe(0);
  });

  it('POST marks the phone stolen and alerts the buddies', async () => {
    const { path, deviceId } = await armLink();
    noopMailer.clear();

    const res = await request(testServer()).post(path);

    expect(res.status).toBe(200);
    expect(res.text).toContain('marked as stolen');
    const episode = await TheftEpisode.findOne({ device: deviceId });
    expect(episode?.openedBy).toBe('owner');
    expect(episode?.status).toBe('open');
    await waitForMail('grace@tambo.app');
  });

  it('the link works once', async () => {
    const { path } = await armLink();
    await request(testServer()).post(path);

    const again = await request(testServer()).post(path);
    expect(again.text).toContain('expired or was already used');
    expect(await TheftEpisode.countDocuments()).toBe(1);
  });

  it('an expired link does nothing', async () => {
    const { path } = await armLink();
    await AlertActionToken.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - MINUTE) } },
    );

    const res = await request(testServer()).post(path);
    expect(res.text).toContain('expired or was already used');
    expect(await TheftEpisode.countDocuments()).toBe(0);
  });

  it('an unknown token gets the dead-link page, a malformed one a 400', async () => {
    const unknown = await request(testServer()).get(
      `/api/v1/alert-actions/${'a'.repeat(96)}`,
    );
    expect(unknown.status).toBe(200);
    expect(unknown.text).toContain('expired or was already used');

    const malformed = await request(testServer()).get(
      '/api/v1/alert-actions/not-a-token',
    );
    expect(malformed.status).toBe(400);
  });
});

describe('a buddy reporting a phone stolen', () => {
  const listProtected = (token: string) =>
    request(testServer())
      .get('/api/v1/protecting')
      .set('Authorization', `Bearer ${token}`);

  const report = (token: string, deviceId: string) =>
    request(testServer())
      .post(`/api/v1/protecting/devices/${deviceId}/report-stolen`)
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'She called me from a friend’s phone' });

  it('lists the people I protect with their devices - and nothing sensitive', async () => {
    const { buddy, deviceId } = await setUpWithBuddy();

    const res = await listProtected(buddy.accessToken);

    expect(res.status).toBe(200);
    expect(res.body.people).toEqual([
      {
        owner: { id: expect.any(String), name: 'Ada Lovelace' },
        devices: [
          {
            id: deviceId,
            name: 'Tecno Spark 20',
            make: 'Tecno',
            deviceModel: 'Spark 20',
            status: 'active',
          },
        ],
      },
    ]);
  });

  it('opens an episode on the owner’s behalf and alerts everyone', async () => {
    const { buddy, deviceId } = await setUpWithBuddy();

    const res = await report(buddy.accessToken, deviceId);

    expect(res.status).toBe(201);
    const episode = await TheftEpisode.findOne({ device: deviceId });
    expect(episode?.openedBy).toBe('buddy');
    expect(episode?.reportedBy?.toString()).toBe(buddy.userId);
    await waitForMail('ada@tambo.app');
    const ownerMail = noopMailer.sent.find((m) => m.to === 'ada@tambo.app');
    expect(ownerMail?.text).toContain(
      'reported as possibly stolen by Grace Hopper (a Tambo buddy)',
    );

    // a second report converges on the same episode
    const again = await report(buddy.accessToken, deviceId);
    expect(again.status).toBe(200);
    expect(await TheftEpisode.countDocuments()).toBe(1);
  });

  it('a stranger cannot report - indistinguishable from an unknown device', async () => {
    const { deviceId } = await setUpEnrolled();
    const stranger = await registerUser({ email: 'mallory@tambo.app' });

    const res = await report(stranger.accessToken, deviceId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
    expect(await TheftEpisode.countDocuments()).toBe(0);
  });

  it('a pending (not yet accepted) buddy cannot report', async () => {
    const { owner, deviceId } = await setUpEnrolled();
    const pending = await registerUser({ email: 'grace@tambo.app' });
    await request(testServer())
      .post('/api/v1/buddies')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: 'grace@tambo.app' });

    const res = await report(pending.accessToken, deviceId);
    expect(res.status).toBe(404);
    expect((await listProtected(pending.accessToken)).body.people).toEqual([]);
  });
});
