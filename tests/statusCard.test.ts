import crypto from 'crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { testServer } from './setup/testServer';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import Partner from '../src/models/partner.model';
import PartnerApiKey from '../src/models/partnerApiKey.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { hashOpaqueToken, sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const auth = (token: string) => `Bearer ${token}`;
const IMEI = '356938035643809';

const enrol = async (email?: string, partnerCode?: string) => {
  const user = await registerUser(email ? { email } : {});
  const res = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', auth(user.accessToken))
    .send({
      name: 'My Tecno',
      imeis: [IMEI],
      make: 'Tecno',
      deviceModel: 'Spark 20',
      ...(partnerCode ? { partnerCode } : {}),
    });
  expect(res.status).toBe(201);
  return {
    ...user,
    deviceId: res.body.device._id as string,
    ingestToken: res.body.ingestToken as string,
  };
};

let seq = 0;
const envelope = (type: string, payloadObj: object = {}) => {
  const payload = JSON.stringify(payloadObj);
  seq += 1;
  return {
    id: `card-${Date.now()}-${seq}`,
    type,
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

const ownerCard = (accessToken: string, deviceId: string) =>
  request(testServer())
    .get(`/api/v1/devices/${deviceId}/status-card`)
    .set('Authorization', auth(accessToken));

const deviceCard = (ingestToken: string) =>
  request(testServer())
    .get('/api/v1/evidence/status')
    .set('X-Device-Token', ingestToken);

const acmePartner = async () => {
  const partner = await Partner.create({
    code: `p${crypto.randomBytes(4).toString('hex')}`,
    name: 'Acme Phones',
    type: 'oem',
    brand: {
      displayName: 'Acme Protect',
      colors: { primary: '#0A7F3F', onPrimary: '#FFFFFF' },
    },
  });
  const apiKey = `tpk_${crypto.randomBytes(32).toString('base64url')}`;
  await PartnerApiKey.create({
    partner: partner._id,
    name: 'Factory',
    prefix: apiKey.slice(0, 12),
    keyHash: hashOpaqueToken(apiKey),
    createdBy: new Types.ObjectId(),
  });
  return { code: partner.code, apiKey };
};

describe("GET /api/v1/devices/:id/status-card (the owner's card)", () => {
  it('shows a quiet phone as protected, in the Tambo brand', async () => {
    const { accessToken, deviceId } = await enrol();
    const res = await ownerCard(accessToken, deviceId);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.card).toMatchObject({
      deviceId,
      deviceName: 'My Tecno',
      state: 'protected',
      brand: { displayName: 'Tambo' },
      lastSeenAt: null,
      unlockAttempts: { inWindow: 0, threshold: 3 },
      episode: null,
      refreshAfterSeconds: 1800,
    });
  });

  it('counts failed unlocks below the threshold and records last seen', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await ingest(ingestToken, [envelope('UNLOCK_FAILED')]);
    const { card } = (await ownerCard(accessToken, deviceId)).body;
    expect(card.state).toBe('protected');
    expect(card.unlockAttempts.inWindow).toBe(1);
    expect(card.lastSeenAt).toEqual(expect.any(String));
  });

  it('shows an open episode with bursts, pending commands and where it was', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', auth(accessToken))
      .send({});
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/commands`)
      .set('Authorization', auth(accessToken))
      .send({ type: 'locate' });

    const frame = (burstId: string, n: number) =>
      envelope('PHOTO', { burstId, seq: n, camera: 'front' });
    await ingest(ingestToken, [
      frame('burst-aaaa', 0),
      frame('burst-aaaa', 1),
      frame('burst-bbbb', 0),
      envelope('PHOTO', {}),
      envelope('TRAIL_POINT', { lat: -1.2921, lng: 36.8219, accuracyM: 12 }),
    ]);

    const { card } = (await ownerCard(accessToken, deviceId)).body;
    expect(card.state).toBe('stolen');
    expect(card.episode).toMatchObject({
      openedBy: 'owner',
      // two bursts plus one legacy photo, a burst of one
      snapshotBursts: 3,
      pendingCommands: 1,
      lastLocation: { lat: -1.2921, lng: 36.8219, accuracyM: 12 },
    });
  });

  it('never shows a location from before the episode', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    await ingest(ingestToken, [
      envelope('TRAIL_POINT', { lat: -1.2921, lng: 36.8219 }),
    ]);
    // the fix predates the back-attach window: it is routine, not incident
    await EvidenceEnvelope.updateMany(
      {},
      { $set: { receivedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } },
    );
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', auth(accessToken))
      .send({});

    const { card } = (await ownerCard(accessToken, deviceId)).body;
    expect(card.state).toBe('stolen');
    expect(card.episode.lastLocation).toBeNull();
  });

  it('is paused once the ingest token is revoked', async () => {
    const { accessToken, deviceId } = await enrol();
    await request(testServer())
      .delete(`/api/v1/devices/${deviceId}/token`)
      .set('Authorization', auth(accessToken));
    const { card } = (await ownerCard(accessToken, deviceId)).body;
    expect(card.state).toBe('paused');
  });

  it('paints the partner brand', async () => {
    const { code } = await acmePartner();
    const { accessToken, deviceId } = await enrol(undefined, code);
    const { card } = (await ownerCard(accessToken, deviceId)).body;
    expect(card.brand).toMatchObject({
      displayName: 'Acme Protect',
      colors: { primary: '#0A7F3F', onPrimary: '#FFFFFF' },
    });
  });

  it("is 404 on someone else's phone", async () => {
    const owner = await enrol();
    const other = await registerUser({ email: 'other-owner@tambo.app' });
    const res = await ownerCard(other.accessToken, owner.deviceId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });
});

describe("GET /api/v1/evidence/status (the phone's own card)", () => {
  it('needs the device token', async () => {
    const res = await request(testServer()).get('/api/v1/evidence/status');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_device_token');
  });

  it('shows protection and brand only', async () => {
    const { deviceId, ingestToken } = await enrol();
    const res = await deviceCard(ingestToken);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Object.keys(res.body.card).sort()).toEqual([
      'brand',
      'deviceId',
      'deviceName',
      'generatedAt',
      'refreshAfterSeconds',
      'state',
    ]);
    expect(res.body.card).toMatchObject({ deviceId, state: 'protected' });
  });

  it('never reveals an open episode to whoever holds the phone', async () => {
    const { ingestToken } = await enrol();
    const opened = await ingest(ingestToken, [
      envelope('UNLOCK_FAILED'),
      envelope('UNLOCK_FAILED'),
      envelope('UNLOCK_FAILED'),
    ]);
    expect(opened.body.episodeOpened).toBe(true);

    const { card } = (await deviceCard(ingestToken)).body;
    expect(card.state).toBe('protected');
    expect(JSON.stringify(card)).not.toMatch(/episode|stolen|unlock|lat/i);
  });

  it('is unlinked on a provisioned phone nobody has signed in on', async () => {
    const { apiKey } = await acmePartner();
    const provisioned = await request(testServer())
      .post('/api/v1/partner/devices')
      .set('X-Api-Key', apiKey)
      .send({
        devices: [{ imeis: [IMEI], make: 'Tecno', deviceModel: 'Spark 20' }],
      });
    const claimed = await request(testServer())
      .post('/api/v1/devices/claim')
      .send({
        provisioningToken: provisioned.body.devices[0].provisioningToken,
        installId: 'install-0123456789abcdef',
      });

    const { card } = (await deviceCard(claimed.body.ingestToken)).body;
    expect(card).toMatchObject({
      state: 'unlinked',
      brand: { displayName: 'Acme Protect' },
    });
  });
});
