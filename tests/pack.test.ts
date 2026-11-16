import crypto from 'crypto';
import request from 'supertest';
import { testServer } from './setup/testServer';
import PackDelivery from '../src/models/packDelivery.model';
import { canonicalManifest } from '../src/services/pack.service';
import type { EvidencePack } from '../src/services/pack.service';
import { verifyManifest } from '../src/utils/signing';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';
import { retryPhantom } from './helpers/http';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

// a minimal valid 1x1 JPEG so the PDF's image embedding path really runs
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFA' +
    'ABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

interface Scene {
  accessToken: string;
  deviceId: string;
  ingestToken: string;
  episodeId: string;
}

/**
 * First alerts are dispatched fire-and-forget AFTER the triggering response
 * returns (by design: alerting must never block theft detection), so tests
 * poll for the outcome instead of assuming it landed synchronously.
 */
const until = async (
  predicate: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met within timeout');
};

const firstAlerts = (): Promise<number> =>
  PackDelivery.countDocuments({ kind: 'first_alert' });

let seq = 0;
const envelope = (type: string, payloadObj: object) => {
  const payload = JSON.stringify(payloadObj);
  seq += 1;
  return {
    id: `pack-${Date.now()}-${seq}`,
    type,
    capturedAt: new Date().toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

/** Owner + device + open episode + a spread of evidence, including a photo. */
const buildScene = async (): Promise<Scene> => {
  const { accessToken } = await registerUser();
  const enrolled = await retryPhantom(
    () =>
      request(testServer())
        .post('/api/v1/devices')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          name: 'My Tecno',
          imeis: ['356938035643809'],
          make: 'Tecno',
          deviceModel: 'Spark 20',
          colour: 'black',
        }),
    'enrol-device',
  );
  const deviceId = enrolled.body.device._id as string;
  const ingestToken = enrolled.body.ingestToken as string;

  const stolen = await request(testServer())
    .post(`/api/v1/devices/${deviceId}/mark-stolen`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ note: 'snatched at Kencom stage' });
  const episodeId = stolen.body.episode._id as string;
  await until(async () => (await firstAlerts()) >= 1);

  const photo = envelope('PHOTO', { camera: 'front' });
  await request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', ingestToken)
    .send({
      envelopes: [
        envelope('UNLOCK_FAILED', { attempt: 1 }),
        envelope('UNLOCK_FAILED', { attempt: 2 }),
        envelope('TRAIL_POINT', { lat: -1.2921, lng: 36.8219, accuracy: 15 }),
        envelope('TRAIL_POINT', { lat: -1.3005, lng: 36.83 }),
        envelope('DEVICE_SNAPSHOT', { battery: 43 }),
        photo,
      ],
    });
  await request(testServer())
    .post(`/api/v1/evidence/${photo.id}/media`)
    .set('X-Device-Token', ingestToken)
    .set('X-Content-Sha256', sha256Hex(TINY_JPEG))
    .set('Content-Type', 'image/jpeg')
    .send(TINY_JPEG);

  return { accessToken, deviceId, ingestToken, episodeId };
};

const getPack = async (scene: Scene): Promise<EvidencePack> => {
  const res = await request(testServer())
    .get(`/api/v1/episodes/${scene.episodeId}/pack`)
    .set('Authorization', `Bearer ${scene.accessToken}`);
  expect(res.status).toBe(200);
  return res.body.pack as EvidencePack;
};

describe('first alert', () => {
  it('emails the owner the moment an episode opens, with the pack to follow', async () => {
    await buildScene();

    const alert = noopMailer.sent.find((mail) =>
      mail.subject.includes('may be stolen'),
    );
    expect(alert).toBeDefined();
    expect(alert?.to).toBe('ada@tambo.app');
    expect(alert?.text).toContain('OB number');

    expect(await PackDelivery.countDocuments({ kind: 'first_alert' })).toBe(1);
  });

  it('alerts only accepted buddies, never pending or declined ones', async () => {
    const { accessToken } = await registerUser();

    // three buddies, each an actual Tambo user, in three link states
    for (const email of [
      'accepted@tambo.app',
      'declinedbuddy@tambo.app',
      'pending@tambo.app',
    ]) {
      const buddy = await registerUser({ email });
      await request(testServer())
        .post('/api/v1/buddies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ email });
      const invites = await request(testServer())
        .get('/api/v1/buddy-invites')
        .set('Authorization', `Bearer ${buddy.accessToken}`);
      const inviteId = invites.body.invites[0].id as string;
      if (email === 'accepted@tambo.app') {
        await request(testServer())
          .post(`/api/v1/buddy-invites/${inviteId}/accept`)
          .set('Authorization', `Bearer ${buddy.accessToken}`);
      }
      if (email === 'declinedbuddy@tambo.app') {
        await request(testServer())
          .post(`/api/v1/buddy-invites/${inviteId}/decline`)
          .set('Authorization', `Bearer ${buddy.accessToken}`);
      }
    }
    noopMailer.clear();

    const enrolled = await request(testServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'P',
        imeis: ['356938035643809'],
        make: 'T',
        deviceModel: 'S',
      });
    await request(testServer())
      .post(`/api/v1/devices/${enrolled.body.device._id}/mark-stolen`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    // owner + the single accepted buddy = 2 first alerts
    await until(async () => (await firstAlerts()) >= 2);
    const alertedTo = noopMailer.sent.map((mail) => mail.to).sort();
    expect(alertedTo).toContain('accepted@tambo.app');
    expect(alertedTo).not.toContain('declinedbuddy@tambo.app');
    expect(alertedTo).not.toContain('pending@tambo.app');
  });

  it('never double-alerts: steal-recover-steal alerts once per episode', async () => {
    const scene = await buildScene();
    expect(await firstAlerts()).toBe(1);

    // converging second mark-stolen on the SAME episode: no new alert
    await request(testServer())
      .post(`/api/v1/devices/${scene.deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${scene.accessToken}`)
      .send({});
    await new Promise((resolve) => setTimeout(resolve, 150)); // give any wrong send time to land
    expect(await firstAlerts()).toBe(1);

    // a NEW episode alerts again
    await request(testServer())
      .post(`/api/v1/devices/${scene.deviceId}/mark-recovered`)
      .set('Authorization', `Bearer ${scene.accessToken}`);
    await request(testServer())
      .post(`/api/v1/devices/${scene.deviceId}/mark-stolen`)
      .set('Authorization', `Bearer ${scene.accessToken}`)
      .send({});
    await until(async () => (await firstAlerts()) >= 2);
    expect(await firstAlerts()).toBe(2);
  });
});

describe('GET /episodes/:id/pack', () => {
  it('assembles every Kenya-mapped section', async () => {
    const scene = await buildScene();
    const pack = await getPack(scene);

    expect(pack.version).toBe(1);
    expect(pack.episode).toMatchObject({
      openedBy: 'owner',
      note: 'snatched at Kencom stage',
    });
    expect(pack.episode.firstAlertAt).toBeTruthy();
    expect(pack.owner.name).toBe('Ada Lovelace');
    expect(pack.device).toMatchObject({
      make: 'Tecno',
      model: 'Spark 20',
      imeis: ['356938035643809'],
    });
    expect(pack.unlockAttempts).toHaveLength(2);
    expect(pack.trail).toHaveLength(2);
    expect(pack.trail[0]).toMatchObject({
      source: 'TRAIL_POINT',
      lat: -1.2921,
      lng: 36.8219,
      accuracyM: 15,
      familiar: null,
    });
    expect(pack.trail[0]!.mapsLink).toContain('maps.google.com');
    expect(pack.trail[0]!.capturedAt).toBeTruthy();
    // the two fixes are ~1.2km apart: a moving trail; the two UNLOCK_FAILED
    // envelopes and the photo carried no location, so they count as fixless
    // check-ins (a photo is a location-bearing type since F4)
    expect(pack.trailSummary).toEqual({
      movement: 'moving',
      leftFamiliar: null,
      pointsWithoutFix: 3,
    });
    expect(pack.photos).toHaveLength(1);
    expect(pack.photos[0]!.sha256).toBe(sha256Hex(TINY_JPEG));
    // a pre-F4 photo (no burstId) reads as a set of one, so it is never lost
    expect(pack.snapshotSets).toHaveLength(1);
    expect(pack.snapshotSets[0]).toMatchObject({
      trigger: 'unknown',
      cameras: { front: 1, back: 0, unknown: 0 },
      location: null,
    });
    expect(pack.snapshotSets[0]!.frames[0]).toMatchObject({
      hasMedia: true,
      sha256: sha256Hex(TINY_JPEG),
    });
    expect(pack.otherEvidence).toHaveLength(1);
    expect(pack.actionChecklist.join(' ')).toContain('eCitizen');
    expect(pack.actionChecklist.join(' ')).toContain('OB');
  });

  it('the manifest covers every envelope and the signature verifies - until tampered with', async () => {
    const scene = await buildScene();
    const pack = await getPack(scene);

    expect(pack.integrity.manifest).toHaveLength(6);
    expect(pack.integrity.statement).toContain('not a forensic');

    const canonical = canonicalManifest(
      pack.integrity.manifest,
      pack.generatedAt,
    );
    expect(verifyManifest(canonical, pack.integrity.signatureBase64)).toBe(
      true,
    );

    // any change to any item breaks the signature
    const tampered = [...pack.integrity.manifest];
    tampered[0] = { ...tampered[0]!, sha256: sha256Hex('forged') };
    expect(
      verifyManifest(
        canonicalManifest(tampered, pack.generatedAt),
        pack.integrity.signatureBase64,
      ),
    ).toBe(false);
  });

  it("is invisible to another user's account", async () => {
    const scene = await buildScene();
    const attacker = await registerUser({ email: 'mallory@tambo.app' });

    const res = await request(testServer())
      .get(`/api/v1/episodes/${scene.episodeId}/pack`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /episodes/:id/pack.pdf', () => {
  it('renders a real PDF with the photo embedded', async () => {
    const scene = await buildScene();

    const res = await request(testServer())
      .get(`/api/v1/episodes/${scene.episodeId}/pack.pdf`)
      .set('Authorization', `Bearer ${scene.accessToken}`)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const pdf = res.body as Buffer;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });

  it('survives a photo whose bytes are not a decodable image', async () => {
    const { accessToken } = await registerUser();
    const enrolled = await request(testServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'P',
        imeis: ['356938035643809'],
        make: 'T',
        deviceModel: 'S',
      });
    const stolen = await request(testServer())
      .post(`/api/v1/devices/${enrolled.body.device._id}/mark-stolen`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});

    const photo = envelope('PHOTO', { camera: 'front' });
    await request(testServer())
      .post('/api/v1/evidence')
      .set('X-Device-Token', enrolled.body.ingestToken)
      .send({ envelopes: [photo] });
    const garbage = crypto.randomBytes(512);
    await request(testServer())
      .post(`/api/v1/evidence/${photo.id}/media`)
      .set('X-Device-Token', enrolled.body.ingestToken)
      .set('X-Content-Sha256', sha256Hex(garbage))
      .set('Content-Type', 'image/jpeg')
      .send(garbage);

    const res = await request(testServer())
      .get(`/api/v1/episodes/${stolen.body.episode._id}/pack.pdf`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /episodes/:id/send-pack', () => {
  it('emails the PDF to the owner and eligible contacts, and records each send', async () => {
    const scene = await buildScene();
    noopMailer.clear();

    const res = await request(testServer())
      .post(`/api/v1/episodes/${scene.episodeId}/send-pack`)
      .set('Authorization', `Bearer ${scene.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual(['ada@tambo.app']);

    const mail = noopMailer.sent.at(-1);
    expect(mail?.subject).toContain('evidence pack');
    expect(mail?.attachments).toHaveLength(1);
    expect(mail?.attachments?.[0]?.filename).toContain('.pdf');
    // the attachment is a real PDF
    const pdf = Buffer.from(mail!.attachments![0]!.content, 'base64');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    expect(await PackDelivery.countDocuments({ kind: 'full_pack' })).toBe(1);

    // re-sending is allowed (more evidence may have arrived) and audited
    await request(testServer())
      .post(`/api/v1/episodes/${scene.episodeId}/send-pack`)
      .set('Authorization', `Bearer ${scene.accessToken}`);
    expect(await PackDelivery.countDocuments({ kind: 'full_pack' })).toBe(2);
  });

  it("cannot be triggered on someone else's episode", async () => {
    const scene = await buildScene();
    const attacker = await registerUser({ email: 'mallory@tambo.app' });

    const res = await request(testServer())
      .post(`/api/v1/episodes/${scene.episodeId}/send-pack`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);
    expect(res.status).toBe(404);
  });
});
