import request from 'supertest';
import { testServer } from './setup/testServer';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import User from '../src/models/user.model';
import { effectivePlan, entitlementsFor } from '../src/services/entitlements';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const auth = (token: string) => `Bearer ${token}`;

const setPlanDirect = (userId: string, plan: string, expiresAt?: Date) =>
  User.updateOne(
    { _id: userId },
    expiresAt
      ? { $set: { plan, planExpiresAt: expiresAt } }
      : { $set: { plan } },
  );

const enrol = (accessToken: string, name = 'P', imei = '356938035643809') =>
  request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', auth(accessToken))
    .send({ name, imeis: [imei], make: 'T', deviceModel: 'S' });

describe('entitlements (pure)', () => {
  it('a lapsed paid plan reads as free; a live one does not', () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    expect(effectivePlan({ plan: 'pro', planExpiresAt: past })).toBe('free');
    expect(effectivePlan({ plan: 'pro', planExpiresAt: future })).toBe('pro');
    expect(effectivePlan({ plan: 'family' })).toBe('family');
    expect(entitlementsFor({ plan: 'pro', planExpiresAt: past })).toEqual(
      entitlementsFor({ plan: 'free' }),
    );
  });
});

describe('GET /api/v1/plan', () => {
  it('reports free defaults for a new account', async () => {
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .get('/api/v1/plan')
      .set('Authorization', auth(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.plan).toEqual({
      plan: 'free',
      effectivePlan: 'free',
      expiresAt: null,
      entitlements: {
        maxDevices: 1,
        historyDays: 7,
        trailCadenceSeconds: 300,
        pushAlerts: false,
      },
    });
  });

  it('reports full history as null for a paid plan', async () => {
    const { accessToken, userId } = await registerUser();
    await setPlanDirect(userId, 'family');
    const res = await request(testServer())
      .get('/api/v1/plan')
      .set('Authorization', auth(accessToken));
    expect(res.body.plan.entitlements).toMatchObject({
      maxDevices: 5,
      historyDays: null,
      pushAlerts: true,
    });
  });
});

describe('PATCH /api/v1/plan/:userId (admin)', () => {
  it('is admin-only', async () => {
    const owner = await registerUser();
    const res = await request(testServer())
      .patch(`/api/v1/plan/${owner.userId}`)
      .set('Authorization', auth(owner.accessToken))
      .send({ plan: 'pro' });
    expect(res.status).toBe(403);
  });

  it('an admin flips a plan; downgrading to free drops the expiry', async () => {
    const owner = await registerUser();
    const admin = await registerUser({ email: 'admin@tambo.app' });
    await User.updateOne({ _id: admin.userId }, { $set: { role: 'admin' } });
    // role lives inside the access token: sign in again to pick it up
    const adminSession = await request(testServer())
      .post('/api/auth/login')
      .send({ email: 'admin@tambo.app', password: 'correct-horse-battery' });
    const adminToken = adminSession.body.tokens.accessToken as string;

    const upgraded = await request(testServer())
      .patch(`/api/v1/plan/${owner.userId}`)
      .set('Authorization', auth(adminToken))
      .send({
        plan: 'pro',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      });
    expect(upgraded.status).toBe(200);
    expect(upgraded.body.plan.plan).toBe('pro');
    expect(upgraded.body.plan.expiresAt).not.toBeNull();

    const downgraded = await request(testServer())
      .patch(`/api/v1/plan/${owner.userId}`)
      .set('Authorization', auth(adminToken))
      .send({ plan: 'free' });
    expect(downgraded.body.plan).toMatchObject({
      plan: 'free',
      expiresAt: null,
    });
  });
});

describe('device limit enforcement', () => {
  it('free stops at 1 device with device_limit; family reaches 5', async () => {
    const { accessToken, userId } = await registerUser();

    expect((await enrol(accessToken, 'first')).status).toBe(201);
    const second = await enrol(accessToken, 'second', '356938035643817');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('device_limit');

    await setPlanDirect(userId, 'family');
    for (let i = 2; i <= 5; i += 1) {
      const res = await enrol(
        accessToken,
        `dev-${i}`,
        `3569380356438${10 + i}`,
      );
      expect(res.status).toBe(201);
    }
    const sixth = await enrol(accessToken, 'sixth', '356938035643899');
    expect(sixth.status).toBe(409);
  });

  it('a lapsed plan blocks NEW enrolment but existing devices keep reporting', async () => {
    const { accessToken, userId } = await registerUser();
    await setPlanDirect(userId, 'family', new Date(Date.now() + 60_000));

    const a = await enrol(accessToken, 'a');
    const b = await enrol(accessToken, 'b', '356938035643817');
    expect(b.status).toBe(201);

    await setPlanDirect(userId, 'family', new Date(Date.now() - 1000)); // lapse
    const c = await enrol(accessToken, 'c', '356938035643825');
    expect(c.status).toBe(409); // over the free allowance now

    // the lapsed plan never bricks protection: ingest still works
    const payload = JSON.stringify({ attemptNo: 1 });
    const ingest = await request(testServer())
      .post('/api/v1/evidence')
      .set('X-Device-Token', a.body.ingestToken as string)
      .send({
        envelopes: [
          {
            id: `plan-${Date.now()}`,
            type: 'UNLOCK_FAILED',
            capturedAt: new Date().toISOString(),
            payload,
            sha256: sha256Hex(payload),
          },
        ],
      });
    expect(ingest.status).toBe(200);
    expect(ingest.body.results[0].status).toBe('acked');
  });
});

describe('history window enforcement', () => {
  it('free accounts see 7 days of activity; pro sees older attempts', async () => {
    const { accessToken, userId } = await registerUser();
    const enrolled = await enrol(accessToken);
    const deviceId = enrolled.body.device._id as string;
    const ingestToken = enrolled.body.ingestToken as string;

    const payload = JSON.stringify({ attemptNo: 1 });
    await request(testServer())
      .post('/api/v1/evidence')
      .set('X-Device-Token', ingestToken)
      .send({
        envelopes: [
          {
            id: `hist-${Date.now()}`,
            type: 'UNLOCK_FAILED',
            capturedAt: new Date().toISOString(),
            payload,
            sha256: sha256Hex(payload),
          },
        ],
      });
    // age the envelope past the free window (receivedAt is server-set, so
    // backdating the stored row is the only way to simulate old history)
    await EvidenceEnvelope.updateMany(
      {},
      { $set: { receivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) } },
    );

    const freeView = await request(testServer())
      .get(`/api/v1/devices/${deviceId}/activity`)
      .set('Authorization', auth(accessToken));
    expect(freeView.body.activity.recent).toHaveLength(0);
    // the truncation is SIGNALLED, so clients can say "showing last 7 days"
    expect(freeView.body.activity.historyDays).toBe(7);

    await setPlanDirect(userId, 'pro');
    const proView = await request(testServer())
      .get(`/api/v1/devices/${deviceId}/activity`)
      .set('Authorization', auth(accessToken));
    expect(proView.body.activity.recent).toHaveLength(1);
    expect(proView.body.activity.historyDays).toBeNull();
  });
});

describe('trail cadence advisory', () => {
  it('rides on ingest responses while an episode is open, tuned to the plan', async () => {
    const { accessToken, userId } = await registerUser();
    const enrolled = await enrol(accessToken);
    const deviceId = enrolled.body.device._id as string;
    const ingestToken = enrolled.body.ingestToken as string;
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', auth(accessToken))
      .send({});
    // drain the fire-and-forget first alert so it cannot leak past afterEach
    {
      const PackDelivery = (await import('../src/models/packDelivery.model'))
        .default;
      const start = Date.now();
      while (Date.now() - start < 3000) {
        if ((await PackDelivery.countDocuments({ kind: 'first_alert' })) >= 1)
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    let seq = 0;
    const send = () => {
      const payload = JSON.stringify({ at: Date.now() });
      seq += 1;
      return request(testServer())
        .post('/api/v1/evidence')
        .set('X-Device-Token', ingestToken)
        .send({
          envelopes: [
            {
              id: `cad-${Date.now()}-${seq}`,
              type: 'TRAIL_POINT',
              capturedAt: new Date().toISOString(),
              payload,
              sha256: sha256Hex(payload),
            },
          ],
        });
    };

    const freeAdvice = await send();
    expect(freeAdvice.body.trailCadenceSeconds).toBe(300);

    await setPlanDirect(userId, 'pro');
    const proAdvice = await send();
    expect(proAdvice.body.trailCadenceSeconds).toBe(60);
  });
});
