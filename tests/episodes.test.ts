import request from 'supertest';
import { testServer } from './setup/testServer';
import TheftEpisode from '../src/models/theftEpisode.model';
import User from '../src/models/user.model';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterAll(closeTestDb);

const enrol = async (accessToken: string) => {
  const res = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'My Tecno',
      imeis: ['356938035643809'],
      make: 'Tecno',
      deviceModel: 'Spark 20',
    });
  return res.body.device._id as string;
};

const markStolen = (accessToken: string, deviceId: string, note?: string) =>
  request(testServer())
    .post(`/api/v1/devices/${deviceId}/mark-stolen`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(note ? { note } : {});

const getDevice = (accessToken: string, deviceId: string) =>
  request(testServer())
    .get(`/api/v1/devices/${deviceId}`)
    .set('Authorization', `Bearer ${accessToken}`);

describe('mark-stolen', () => {
  it('opens an episode and flips the device to stolen', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);

    const res = await markStolen(
      accessToken,
      deviceId,
      'snatched at Kencom stage ~18:30',
    );

    expect(res.status).toBe(201);
    expect(res.body.episode).toMatchObject({
      status: 'open',
      openedBy: 'owner',
      note: 'snatched at Kencom stage ~18:30',
    });

    expect((await getDevice(accessToken, deviceId)).body.device.status).toBe(
      'stolen',
    );
  });

  it('is idempotent: a second call converges on the same open episode', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);

    const first = await markStolen(accessToken, deviceId);
    const second = await markStolen(accessToken, deviceId);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.episode._id).toBe(first.body.episode._id);
    expect(await TheftEpisode.countDocuments({})).toBe(1);
  });

  it('never yields two open episodes under concurrent marking', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);

    await Promise.all([
      markStolen(accessToken, deviceId),
      markStolen(accessToken, deviceId),
    ]);

    expect(await TheftEpisode.countDocuments({ status: 'open' })).toBe(1);
  });
});

describe('mark-recovered', () => {
  it('resolves the episode and restores the device', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);
    await markStolen(accessToken, deviceId);

    const res = await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.episode).toMatchObject({
      status: 'resolved',
      resolution: 'recovered',
    });
    expect(res.body.episode.resolvedAt).toBeTruthy();
    expect((await getDevice(accessToken, deviceId)).body.device.status).toBe(
      'active',
    );
  });

  it('404s when nothing is open', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);

    const res = await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('episode_not_found');
  });

  it('a recovered device can be stolen again: a NEW episode opens', async () => {
    const { accessToken } = await registerUser();
    const deviceId = await enrol(accessToken);

    const first = await markStolen(accessToken, deviceId);
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-recovered`)
      .set('Authorization', `Bearer ${accessToken}`);
    const second = await markStolen(accessToken, deviceId);

    expect(second.status).toBe(201);
    expect(second.body.episode._id).not.toBe(first.body.episode._id);
    expect(await TheftEpisode.countDocuments({})).toBe(2);
  });
});

describe('episode reads', () => {
  it("lists the caller's episodes, filterable by device", async () => {
    const { accessToken, userId } = await registerUser();
    // two devices on one account needs a family plan (free allows 1)
    await User.updateOne({ _id: userId }, { $set: { plan: 'family' } });
    const deviceA = await enrol(accessToken);
    const deviceB = await enrol(accessToken);
    await markStolen(accessToken, deviceA);
    await markStolen(accessToken, deviceB);

    const all = await request(testServer())
      .get('/api/v1/episodes')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(all.body.episodes).toHaveLength(2);

    const filtered = await request(testServer())
      .get(`/api/v1/episodes?deviceId=${deviceA}`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(filtered.body.episodes).toHaveLength(1);
    expect(filtered.body.episodes[0].device).toBe(deviceA);
  });

  it("hides other users' episodes", async () => {
    const owner = await registerUser();
    const attacker = await registerUser({ email: 'mallory@tambo.app' });
    const deviceId = await enrol(owner.accessToken);
    const { body } = await markStolen(owner.accessToken, deviceId);

    const res = await request(testServer())
      .get(`/api/v1/episodes/${body.episode._id}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);

    expect(res.status).toBe(404);
  });
});
