import request from 'supertest';
import { testServer } from './setup/testServer';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterAll(closeTestDb);

const enrol = async (threshold = 3) => {
  const { accessToken } = await registerUser();
  const res = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'My Tecno',
      imeis: ['356938035643809'],
      make: 'Tecno',
      deviceModel: 'Spark 20',
      failedUnlockThreshold: threshold,
    });
  return {
    accessToken,
    deviceId: res.body.device._id as string,
    ingestToken: res.body.ingestToken as string,
  };
};

let seq = 0;
const unlockFailed = () => {
  const payload = JSON.stringify({ attempt: (seq += 1) });
  return {
    id: `ua-${Date.now()}-${seq}`,
    type: 'UNLOCK_FAILED',
    capturedAt: new Date().toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

const ingest = (token: string, envelopes: object[]) =>
  request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', token)
    .send({ envelopes });

const getActivity = (accessToken: string, deviceId: string) =>
  request(testServer())
    .get(`/api/v1/devices/${deviceId}/activity`)
    .set('Authorization', `Bearer ${accessToken}`);

describe('GET /api/v1/devices/:id/activity', () => {
  it('reports zero activity on a quiet device', async () => {
    const { accessToken, deviceId } = await enrol();
    const res = await getActivity(accessToken, deviceId);

    expect(res.status).toBe(200);
    expect(res.body.activity).toMatchObject({
      inWindow: 0,
      threshold: 3,
      toThreshold: 3,
      lastAttemptAt: null,
    });
    expect(res.body.activity.recent).toEqual([]);
  });

  it('surfaces BELOW-threshold attempts the owner could not otherwise see', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol(3);
    await ingest(ingestToken, [unlockFailed(), unlockFailed()]); // 2 of 3

    const res = await getActivity(accessToken, deviceId);
    expect(res.body.activity.inWindow).toBe(2);
    expect(res.body.activity.toThreshold).toBe(1);
    expect(res.body.activity.recent).toHaveLength(2);
    expect(res.body.activity.lastAttemptAt).toBeTruthy();
  });

  it('counts only UNLOCK_FAILED, newest-first, and ignores other evidence', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    const trail = {
      id: `t-${Date.now()}`,
      type: 'TRAIL_POINT',
      capturedAt: new Date().toISOString(),
      payload: JSON.stringify({ lat: -1.29, lng: 36.82 }),
      sha256: sha256Hex(JSON.stringify({ lat: -1.29, lng: 36.82 })),
    };
    await ingest(ingestToken, [unlockFailed(), trail, unlockFailed()]);

    const res = await getActivity(accessToken, deviceId);
    expect(res.body.activity.inWindow).toBe(2);
    // newest-first ordering
    const [first, second] = res.body.activity.recent;
    expect(new Date(first.receivedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(second.receivedAt).getTime(),
    );
  });

  it('clamps toThreshold at 0 once the threshold is met (episode auto-opened)', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol(2);
    await ingest(ingestToken, [unlockFailed(), unlockFailed()]); // crosses

    const res = await getActivity(accessToken, deviceId);
    expect(res.body.activity.inWindow).toBeGreaterThanOrEqual(2);
    expect(res.body.activity.toThreshold).toBe(0);
  });

  it("is owner-scoped: another user's device 404s like a missing one", async () => {
    const { deviceId } = await enrol();
    const attacker = await registerUser({ email: 'mallory@tambo.app' });

    const res = await getActivity(attacker.accessToken, deviceId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });

  it('requires authentication', async () => {
    const { deviceId } = await enrol();
    expect(
      (await request(testServer()).get(`/api/v1/devices/${deviceId}/activity`))
        .status,
    ).toBe(401);
  });
});
