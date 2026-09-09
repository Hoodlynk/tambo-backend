import request from 'supertest';
import { testServer } from './setup/testServer';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { parseLocation } from '../src/services/evidenceLocation';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterEach(() => noopMailer.clear());
afterAll(closeTestDb);

const IMEIS = ['356938035643809', '356938035643817'];

const enrol = async (threshold = 3) => {
  const { accessToken } = await registerUser();
  const res = await request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'My Tecno',
      imeis: IMEIS,
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
const envelope = (type: string, body: object) => {
  const payload = JSON.stringify(body);
  return {
    id: `loc-${Date.now()}-${(seq += 1)}`,
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

const getActivity = (accessToken: string, deviceId: string) =>
  request(testServer())
    .get(`/api/v1/devices/${deviceId}/activity`)
    .set('Authorization', `Bearer ${accessToken}`);

/** The alert is dispatched fire-and-forget; give the microtask queue a beat. */
const alertMail = async () => {
  for (let i = 0; i < 50; i += 1) {
    const mail = noopMailer.sent.find((m) =>
      m.subject.includes('may be stolen'),
    );
    if (mail) return mail;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('first alert never arrived');
};

describe('parseLocation', () => {
  it('reads a nested location object', () => {
    expect(
      parseLocation(
        JSON.stringify({
          attemptNo: 2,
          method: 'pin',
          location: { lat: -1.2921, lng: 36.8219, accuracyM: 12 },
        }),
      ),
    ).toEqual({ lat: -1.2921, lng: 36.8219, accuracyM: 12 });
  });

  it('reads top-level lat/lng and the `accuracy` spelling', () => {
    expect(
      parseLocation(JSON.stringify({ lat: -1.3005, lng: 36.83, accuracy: 15 })),
    ).toEqual({ lat: -1.3005, lng: 36.83, accuracyM: 15 });
  });

  it('returns null for payloads without a usable location', () => {
    expect(parseLocation(JSON.stringify({ attemptNo: 1 }))).toBeNull();
    expect(parseLocation('not json at all')).toBeNull();
    expect(parseLocation(JSON.stringify({ lat: 91, lng: 0 }))).toBeNull();
    expect(parseLocation(JSON.stringify({ lat: '1', lng: '2' }))).toBeNull();
  });
});

describe('unlock activity report locations', () => {
  it('surfaces per-attempt locations when payloads carry them', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol(5);

    await ingest(ingestToken, [
      envelope('UNLOCK_FAILED', {
        attemptNo: 1,
        location: { lat: -1.2921, lng: 36.8219, accuracyM: 10 },
      }),
      envelope('UNLOCK_FAILED', { attemptNo: 2 }),
    ]);

    const res = await getActivity(accessToken, deviceId);
    expect(res.status).toBe(200);

    // newest first: attempt 2 (no location), then attempt 1 (located)
    const [second, first] = res.body.activity.recent;
    expect(second.location).toBeNull();
    expect(first.location).toEqual({
      lat: -1.2921,
      lng: 36.8219,
      accuracyM: 10,
    });
  });
});

describe('first alert essentials', () => {
  it('includes IMEIs and the last known location in the alert email', async () => {
    const { ingestToken } = await enrol(2);

    await ingest(ingestToken, [
      envelope('UNLOCK_FAILED', {
        attemptNo: 1,
        location: { lat: -1.2921, lng: 36.8219, accuracyM: 8 },
      }),
      envelope('UNLOCK_FAILED', { attemptNo: 2 }),
    ]);

    const mail = await alertMail();
    expect(mail.text).toContain(`IMEIs: ${IMEIS.join(', ')}`);
    expect(mail.text).toContain('Last known location: -1.2921, 36.8219 (±8m)');
    expect(mail.text).toContain('https://maps.google.com/?q=-1.2921,36.8219');
  });

  it('says so plainly when no location has been reported yet', async () => {
    const { ingestToken } = await enrol(2);

    await ingest(ingestToken, [
      envelope('UNLOCK_FAILED', { attemptNo: 1 }),
      envelope('UNLOCK_FAILED', { attemptNo: 2 }),
    ]);

    const mail = await alertMail();
    expect(mail.text).toContain('Last known location: not yet reported.');
  });
});
