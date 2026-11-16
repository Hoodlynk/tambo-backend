import request from 'supertest';
import { testServer } from './setup/testServer';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import PackDelivery from '../src/models/packDelivery.model';
import { parseSnapshot } from '../src/services/evidenceSnapshot';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { burstsFromEnvelopes } from '../src/services/snapshot.service';
import type { SnapshotEnvelope } from '../src/services/snapshot.service';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

// a minimal valid 1x1 JPEG so the real bytes path runs end to end
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFA' +
    'ABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);

const CBD = { lat: -1.2921, lng: 36.8219, accuracyM: 12 };
const AWAY = { lat: -1.3005, lng: 36.83, accuracyM: 9 };

const auth = (token: string) => `Bearer ${token}`;

let seq = 0;
const envelope = (type: string, body: object) => {
  const payload = JSON.stringify(body);
  seq += 1;
  return {
    id: `snap-${Date.now()}-${seq}`,
    type,
    capturedAt: new Date().toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

const frame = (
  burstId: string,
  seqNo: number,
  camera: 'front' | 'back',
  extra: object = {},
) =>
  envelope('PHOTO', {
    burstId,
    seq: seqNo,
    count: 2,
    camera,
    trigger: 'failed_unlock',
    ...extra,
  });

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
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const claimed = await PackDelivery.countDocuments({
      episode: episodeId,
      kind: 'first_alert',
    });
    if (claimed >= 1) return episodeId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('first alert never drained');
};

const ingest = (token: string, envelopes: object[]) =>
  request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', token)
    .send({ envelopes });

const upload = (token: string, envelopeId: string, bytes: Buffer) =>
  request(testServer())
    .post(`/api/v1/evidence/${envelopeId}/media`)
    .set('X-Device-Token', token)
    .set('X-Content-Sha256', sha256Hex(bytes))
    .set('Content-Type', 'image/jpeg')
    .send(bytes);

const getSnapshots = (accessToken: string, episodeId: string) =>
  request(testServer())
    .get(`/api/v1/episodes/${episodeId}/snapshots`)
    .set('Authorization', auth(accessToken));

const getMedia = (accessToken: string, episodeId: string, envelopeId: string) =>
  request(testServer())
    .get(`/api/v1/episodes/${episodeId}/snapshots/${envelopeId}`)
    .set('Authorization', auth(accessToken))
    .buffer(true)
    .parse((response, callback) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => callback(null, Buffer.concat(chunks)));
    });

// --- Pure parsing ------------------------------------------------------------

describe('parseSnapshot', () => {
  it('reads a full burst frame', () => {
    expect(
      parseSnapshot(
        JSON.stringify({
          burstId: 'b-0001-abcd',
          seq: 1,
          count: 3,
          camera: 'back',
          trigger: 'tamper',
          headingDeg: 240,
          location: CBD,
        }),
      ),
    ).toEqual({
      burstId: 'b-0001-abcd',
      seq: 1,
      count: 3,
      camera: 'back',
      trigger: 'tamper',
      headingDeg: 240,
    });
  });

  it('treats a legacy or malformed payload as a single unknown-camera photo', () => {
    const legacy = {
      burstId: null,
      seq: null,
      count: null,
      camera: 'unknown',
      trigger: 'unknown',
    };
    expect(parseSnapshot('{"camera":"front"}')).toEqual({
      ...legacy,
      camera: 'front',
    });
    expect(parseSnapshot('not json')).toEqual(legacy);
    expect(parseSnapshot('[]')).toEqual(legacy);
    expect(parseSnapshot('{}')).toEqual(legacy);
  });

  it('drops values outside the contract instead of trusting them', () => {
    const meta = parseSnapshot(
      JSON.stringify({
        burstId: 'x', // too short
        seq: -1,
        count: 2.5,
        camera: 'selfie',
        trigger: 'unknown', // a device never gets to claim this bucket
        headingDeg: 400,
      }),
    );
    expect(meta).toEqual({
      burstId: null,
      seq: null,
      count: null,
      camera: 'unknown',
      trigger: 'unknown',
    });
  });
});

describe('burstsFromEnvelopes', () => {
  const t0 = new Date('2026-11-13T08:00:00Z');
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
  const env = (
    overrides: Partial<SnapshotEnvelope> & { envelopeId: string },
  ): SnapshotEnvelope => ({
    type: 'PHOTO',
    payload: '{}',
    sha256: sha256Hex(overrides.envelopeId),
    receivedAt: t0,
    capturedAt: t0,
    ...overrides,
  });

  it('groups frames by burst, orders them by the device sequence, and pins the first location', () => {
    const payloadWithFix = JSON.stringify({ location: AWAY });
    const result = burstsFromEnvelopes(
      [
        // second frame of the burst arrived first (a retry landed late)
        env({
          envelopeId: 'f-1',
          burstId: 'burst-a',
          seq: 1,
          camera: 'back',
          trigger: 'failed_unlock',
          receivedAt: at(0),
          payload: payloadWithFix,
        }),
        env({
          envelopeId: 'f-0',
          burstId: 'burst-a',
          seq: 0,
          camera: 'front',
          trigger: 'failed_unlock',
          receivedAt: at(1),
          mediaFileId: {} as never,
          mediaSha256: 'ab'.repeat(32),
          mediaBytes: 10,
        }),
        env({ envelopeId: 'legacy-photo', receivedAt: at(2) }),
        env({
          envelopeId: 'f-2',
          burstId: 'burst-b',
          seq: 0,
          camera: 'front',
          trigger: 'tamper',
          receivedAt: at(3),
        }),
        // not a photo: never a snapshot frame
        env({ envelopeId: 'trail', type: 'TRAIL_POINT', receivedAt: at(4) }),
      ],
      [],
    );

    expect(result.summary).toEqual({
      bursts: 3,
      frames: 4,
      framesWithMedia: 1,
    });
    expect(result.bursts.map((burst) => burst.burstId)).toEqual([
      'burst-a',
      'legacy-photo',
      'burst-b',
    ]);
    const [a, legacy, b] = result.bursts;
    expect(a!.frames.map((f) => f.envelopeId)).toEqual(['f-0', 'f-1']);
    expect(a!.cameras).toEqual({ front: 1, back: 1, unknown: 0 });
    expect(a!.location).toMatchObject({ lat: AWAY.lat, lng: AWAY.lng });
    expect(a!.location?.mapsLink).toContain('maps.google.com');
    expect(a!.frames[0]).toMatchObject({
      hasMedia: true,
      sha256: 'ab'.repeat(32),
      bytes: 10,
    });
    expect(a!.frames[1]!.hasMedia).toBe(false);
    expect(legacy!).toMatchObject({
      trigger: 'unknown',
      cameras: { front: 0, back: 0, unknown: 1 },
      location: null,
    });
    expect(b!.trigger).toBe('tamper');
  });
});

// --- Ingest ------------------------------------------------------------------

describe('PHOTO ingest with burst metadata', () => {
  it('copies the burst columns onto the envelope and leaves legacy photos bare', async () => {
    const { ingestToken } = await enrol();
    const modern = frame('burst-0001', 0, 'front', { location: CBD });
    const legacy = envelope('PHOTO', { camera: 'front' });
    const res = await ingest(ingestToken, [modern, legacy]);
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual([
      'acked',
      'acked',
    ]);

    const stored = await EvidenceEnvelope.findOne({ envelopeId: modern.id });
    expect(stored).toMatchObject({
      burstId: 'burst-0001',
      seq: 0,
      camera: 'front',
      trigger: 'failed_unlock',
    });
    const old = await EvidenceEnvelope.findOne({ envelopeId: legacy.id });
    expect(old?.burstId).toBeUndefined();
    expect(old?.seq).toBeUndefined();
    expect(old?.camera).toBe('front');
    expect(old?.trigger).toBe('unknown');
    // a non-photo never gets snapshot columns
    const trail = envelope('TRAIL_POINT', { ...CBD, camera: 'front' });
    await ingest(ingestToken, [trail]);
    const point = await EvidenceEnvelope.findOne({ envelopeId: trail.id });
    expect(point?.camera).toBeUndefined();
  });

  it('advises a snapshot policy only while an episode is open, tuned to the plan', async () => {
    const { accessToken, deviceId, ingestToken } = await enrol();
    const quiet = await ingest(ingestToken, [envelope('STATUS', { ok: 1 })]);
    expect(quiet.body.snapshotPolicy).toBeUndefined();
    expect(quiet.body.trailCadenceSeconds).toBeUndefined();

    await markStolen(accessToken, deviceId);
    const live = await ingest(ingestToken, [envelope('STATUS', { ok: 1 })]);
    expect(live.body.episodeId).toBeTruthy();
    expect(live.body.trailCadenceSeconds).toBe(300);
    expect(live.body.snapshotPolicy).toEqual({
      framesPerCamera: 3,
      intervalSeconds: 2,
      maxBurstsPerEpisode: 5,
    });
  });
});

// --- The owner's read model ------------------------------------------------------

describe('GET /api/v1/episodes/:id/snapshots', () => {
  const scene = async () => {
    const owner = await enrol();
    const episodeId = await markStolen(owner.accessToken, owner.deviceId);
    const front = frame('burst-front-back', 0, 'front', { location: CBD });
    const back = frame('burst-front-back', 1, 'back', {
      location: CBD,
      headingDeg: 90,
    });
    const later = envelope('PHOTO', {
      burstId: 'burst-later',
      seq: 0,
      count: 1,
      camera: 'back',
      trigger: 'periodic',
      location: AWAY,
    });
    // one request per burst so receipt order is deterministic
    await ingest(owner.ingestToken, [front, back]);
    await ingest(owner.ingestToken, [later]);
    await upload(owner.ingestToken, front.id, TINY_JPEG);
    return { ...owner, episodeId, front, back, later };
  };

  it('groups the frames per burst with the place each burst happened', async () => {
    const s = await scene();
    const res = await getSnapshots(s.accessToken, s.episodeId);

    expect(res.status).toBe(200);
    expect(res.body.snapshots.summary).toEqual({
      bursts: 2,
      frames: 3,
      framesWithMedia: 1,
    });
    const [first, second] = res.body.snapshots.bursts;
    expect(first).toMatchObject({
      burstId: 'burst-front-back',
      trigger: 'failed_unlock',
      expectedFrames: 2,
      cameras: { front: 1, back: 1, unknown: 0 },
      location: { lat: CBD.lat, lng: CBD.lng, accuracyM: 12 },
      familiar: null,
    });
    expect(
      first.frames.map((f: { envelopeId: string }) => f.envelopeId),
    ).toEqual([s.front.id, s.back.id]);
    expect(first.frames[0]).toMatchObject({
      camera: 'front',
      hasMedia: true,
      sha256: sha256Hex(TINY_JPEG),
      contentType: 'image/jpeg',
      mediaPath: `/api/v1/episodes/${s.episodeId}/snapshots/${s.front.id}`,
    });
    expect(first.frames[1]).toMatchObject({
      camera: 'back',
      hasMedia: false,
      headingDeg: 90,
    });
    expect(second).toMatchObject({
      burstId: 'burst-later',
      trigger: 'periodic',
      location: { lat: AWAY.lat, lng: AWAY.lng },
    });
  });

  it('annotates a burst taken inside a familiar place', async () => {
    const s = await scene();
    await request(testServer())
      .post('/api/v1/familiar-locations')
      .set('Authorization', auth(s.accessToken))
      .send({ label: 'home', lat: CBD.lat, lng: CBD.lng, radiusM: 200 });

    const res = await getSnapshots(s.accessToken, s.episodeId);
    expect(res.body.snapshots.bursts[0].familiar).toMatchObject({
      label: 'home',
    });
    expect(res.body.snapshots.bursts[1].familiar).toBeNull();
  });

  it('is owner-only: another account and no account both get nothing', async () => {
    const s = await scene();
    const stranger = await registerUser({ email: 'stranger@tambo.app' });
    expect((await getSnapshots(stranger.accessToken, s.episodeId)).status).toBe(
      404,
    );
    expect(
      (
        await request(testServer()).get(
          `/api/v1/episodes/${s.episodeId}/snapshots`,
        )
      ).status,
    ).toBe(401);
  });

  it('snapshot frames count as trail fixes, marked with their source', async () => {
    const s = await scene();
    const res = await request(testServer())
      .get(`/api/v1/episodes/${s.episodeId}/trail`)
      .set('Authorization', auth(s.accessToken));
    expect(res.status).toBe(200);
    expect(
      res.body.trail.points.map((p: { source: string }) => p.source),
    ).toEqual(['PHOTO', 'PHOTO', 'PHOTO']);
    // CBD to AWAY is ~1.2km: the bursts alone prove the phone moved
    expect(res.body.trail.movement).toBe('moving');
  });

  it('the pack carries the same sets, and the flat photo list stays for older clients', async () => {
    const s = await scene();
    const res = await request(testServer())
      .get(`/api/v1/episodes/${s.episodeId}/pack`)
      .set('Authorization', auth(s.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.pack.snapshotSets).toHaveLength(2);
    expect(res.body.pack.snapshotSets[0]).toMatchObject({
      burstId: 'burst-front-back',
      trigger: 'failed_unlock',
      cameras: { front: 1, back: 1, unknown: 0 },
      location: { lat: CBD.lat, lng: CBD.lng },
    });
    expect(res.body.pack.snapshotSets[0].frames[0]).toMatchObject({
      camera: 'front',
      hasMedia: true,
    });
    expect(res.body.pack.photos).toHaveLength(3);
    expect(res.body.pack.trailSummary.movement).toBe('moving');

    const pdf = await request(testServer())
      .get(`/api/v1/episodes/${s.episodeId}/pack.pdf`)
      .set('Authorization', auth(s.accessToken))
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('GET /api/v1/episodes/:id/snapshots/:envelopeId', () => {
  it('streams the stored bytes with the hash and content type', async () => {
    const owner = await enrol();
    const episodeId = await markStolen(owner.accessToken, owner.deviceId);
    const f = frame('burst-bytes', 0, 'front');
    await ingest(owner.ingestToken, [f]);
    await upload(owner.ingestToken, f.id, TINY_JPEG);

    const res = await getMedia(owner.accessToken, episodeId, f.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['x-content-sha256']).toBe(sha256Hex(TINY_JPEG));
    expect(res.headers['content-length']).toBe(String(TINY_JPEG.length));
    expect(Buffer.compare(res.body as Buffer, TINY_JPEG)).toBe(0);
  });

  it('404s for bytes not yet uploaded, an unknown frame, and a frame from another episode', async () => {
    const owner = await enrol();
    const episodeId = await markStolen(owner.accessToken, owner.deviceId);
    const pending = frame('burst-pending', 0, 'front');
    await ingest(owner.ingestToken, [pending]);

    const notYet = await getMedia(owner.accessToken, episodeId, pending.id);
    expect(notYet.status).toBe(404);
    expect(JSON.parse((notYet.body as Buffer).toString()).code).toBe(
      'media_not_available',
    );

    const unknown = await getMedia(owner.accessToken, episodeId, 'no-such-env');
    expect(JSON.parse((unknown.body as Buffer).toString()).code).toBe(
      'snapshot_not_found',
    );

    // a second owner's episode: the envelope id is real, the episode is not theirs
    const other = await enrol('other-owner@tambo.app');
    const otherEpisode = await markStolen(other.accessToken, other.deviceId);
    const theirs = frame('burst-theirs', 0, 'front');
    await ingest(other.ingestToken, [theirs]);
    await upload(other.ingestToken, theirs.id, TINY_JPEG);
    const crossed = await getMedia(owner.accessToken, episodeId, theirs.id);
    expect(JSON.parse((crossed.body as Buffer).toString()).code).toBe(
      'snapshot_not_found',
    );
    const notMine = await getMedia(owner.accessToken, otherEpisode, theirs.id);
    expect(JSON.parse((notMine.body as Buffer).toString()).code).toBe(
      'episode_not_found',
    );
  });
});
