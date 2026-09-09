import request from 'supertest';
import { testServer } from './setup/testServer';
import PackDelivery from '../src/models/packDelivery.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { classifyMovement } from '../src/services/trail.service';
import { matchFamiliar } from '../src/services/familiarLocation.service';
import type { IFamiliarLocation } from '../src/models/familiarLocation.model';
import { haversineMeters } from '../src/utils/geo';
import { sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

// Nairobi CBD and a point ~1.2km away, for unambiguous moving trails
const CBD = { lat: -1.2921, lng: 36.8219 };
const AWAY = { lat: -1.3005, lng: 36.83 };
// ~44m from CBD - inside any static radius
const NEARBY = { lat: -1.2925, lng: 36.8219 };

const auth = (token: string) => `Bearer ${token}`;

const enrol = async () => {
  const user = await registerUser();
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

const markStolen = async (accessToken: string, deviceId: string) => {
  const res = await request(testServer())
    .post(`/api/v1/devices/${deviceId}/mark-stolen`)
    .set('Authorization', auth(accessToken))
    .send({});
  const episodeId = res.body.episode._id as string;
  // drain the fire-and-forget first alert so its mail cannot leak into a
  // later test's mailbox (registerUser reads OTP codes from the latest mail)
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const claimed = await PackDelivery.countDocuments({
      episode: episodeId,
      kind: 'first_alert',
    });
    if (
      claimed >= 1 &&
      noopMailer.sent.some((mail) => mail.subject.includes('may be stolen'))
    ) {
      return episodeId;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('first alert never drained');
};

let seq = 0;
const envelope = (type: string, body: object) => {
  const payload = JSON.stringify(body);
  seq += 1;
  return {
    id: `trail-${Date.now()}-${seq}`,
    type,
    capturedAt: new Date().toISOString(),
    payload,
    sha256: sha256Hex(payload),
  };
};

/** One envelope per request so receivedAt ordering is deterministic. */
const ingestOne = (token: string, env: object) =>
  request(testServer())
    .post('/api/v1/evidence')
    .set('X-Device-Token', token)
    .send({ envelopes: [env] });

const getTrail = (accessToken: string, episodeId: string) =>
  request(testServer())
    .get(`/api/v1/episodes/${episodeId}/trail`)
    .set('Authorization', auth(accessToken));

const addFamiliar = (accessToken: string, body: object) =>
  request(testServer())
    .post('/api/v1/familiar-locations')
    .set('Authorization', auth(accessToken))
    .send(body);

// --- Pure geometry -----------------------------------------------------------

describe('classifyMovement', () => {
  it('is unknown with fewer than two fixes', () => {
    expect(classifyMovement([])).toBe('unknown');
    expect(classifyMovement([CBD])).toBe('unknown');
  });

  it('is static when every fix stays within 150m of the first', () => {
    expect(classifyMovement([CBD, NEARBY, CBD])).toBe('static');
  });

  it('widens the static radius when the fixes themselves are inaccurate', () => {
    // ~350m apart, but ±200m accuracy makes the radius 400m
    const roughA = { ...CBD, accuracyM: 200 };
    const roughB = { lat: -1.29525, lng: 36.8219, accuracyM: 200 };
    expect(haversineMeters(roughA, roughB)).toBeGreaterThan(150);
    expect(classifyMovement([roughA, roughB])).toBe('static');
    // the same pair with tight accuracy is a move
    expect(
      classifyMovement([
        { ...roughA, accuracyM: 10 },
        { ...roughB, accuracyM: 10 },
      ]),
    ).toBe('moving');
  });

  it('is moving once any fix leaves the radius', () => {
    expect(classifyMovement([CBD, NEARBY, AWAY])).toBe('moving');
  });
});

describe('matchFamiliar', () => {
  const place = (label: string, at: { lat: number; lng: number }, radiusM = 200) =>
    ({ label, ...at, radiusM }) as unknown as IFamiliarLocation;

  it('matches a fix inside the radius and reports the distance', () => {
    const match = matchFamiliar([place('home', CBD)], NEARBY);
    expect(match?.label).toBe('home');
    expect(match?.distanceM).toBeGreaterThan(30);
    expect(match?.distanceM).toBeLessThan(60);
  });

  it('prefers the nearest place when radii overlap, and misses outside all', () => {
    expect(
      matchFamiliar([place('work', NEARBY, 500), place('home', CBD, 500)], CBD)
        ?.label,
    ).toBe('home');
    expect(matchFamiliar([place('home', CBD)], AWAY)).toBeNull();
  });
});

// --- Familiar locations CRUD ---------------------------------------------------

describe('/api/v1/familiar-locations', () => {
  it('requires auth', async () => {
    const res = await request(testServer()).get('/api/v1/familiar-locations');
    expect(res.status).toBe(401);
  });

  it('creates, lists, updates, and deletes owner places', async () => {
    const { accessToken } = await registerUser();

    const created = await addFamiliar(accessToken, { label: 'home', ...CBD });
    expect(created.status).toBe(201);
    expect(created.body.location).toMatchObject({
      label: 'home',
      lat: CBD.lat,
      lng: CBD.lng,
      radiusM: 200, // the default
    });
    const id = created.body.location._id as string;

    const updated = await request(testServer())
      .patch(`/api/v1/familiar-locations/${id}`)
      .set('Authorization', auth(accessToken))
      .send({ radiusM: 300 });
    expect(updated.status).toBe(200);
    expect(updated.body.location.radiusM).toBe(300);

    const listed = await request(testServer())
      .get('/api/v1/familiar-locations')
      .set('Authorization', auth(accessToken));
    expect(listed.status).toBe(200);
    expect(listed.body.locations).toHaveLength(1);

    const deleted = await request(testServer())
      .delete(`/api/v1/familiar-locations/${id}`)
      .set('Authorization', auth(accessToken));
    expect(deleted.status).toBe(204);

    const after = await request(testServer())
      .get('/api/v1/familiar-locations')
      .set('Authorization', auth(accessToken));
    expect(after.body.locations).toHaveLength(0);
  });

  it('rejects a duplicate label with 409', async () => {
    const { accessToken } = await registerUser();
    await addFamiliar(accessToken, { label: 'home', ...CBD });
    const dup = await addFamiliar(accessToken, { label: 'home', ...AWAY });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('familiar_location_exists');
  });

  it('caps the list at 10 places', async () => {
    const { accessToken } = await registerUser();
    for (let i = 0; i < 10; i += 1) {
      const res = await addFamiliar(accessToken, { label: `place-${i}`, ...CBD });
      expect(res.status).toBe(201);
    }
    const eleventh = await addFamiliar(accessToken, { label: 'one-too-many', ...CBD });
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.code).toBe('familiar_location_limit');
  });

  it('rejects out-of-range coordinates and radii', async () => {
    const { accessToken } = await registerUser();
    for (const body of [
      { label: 'bad', lat: 91, lng: 0 },
      { label: 'bad', lat: 0, lng: 181 },
      { label: 'bad', ...CBD, radiusM: 5000 },
    ]) {
      const res = await addFamiliar(accessToken, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('validation_error');
    }
  });

  it("cannot touch another user's place", async () => {
    const owner = await registerUser();
    const created = await addFamiliar(owner.accessToken, { label: 'home', ...CBD });
    const id = created.body.location._id as string;

    const stranger = await registerUser({ email: 'mallory@tambo.app' });
    const patch = await request(testServer())
      .patch(`/api/v1/familiar-locations/${id}`)
      .set('Authorization', auth(stranger.accessToken))
      .send({ label: 'mine now' });
    expect(patch.status).toBe(404);

    const del = await request(testServer())
      .delete(`/api/v1/familiar-locations/${id}`)
      .set('Authorization', auth(stranger.accessToken));
    expect(del.status).toBe(404);
  });
});

// --- The trail read model --------------------------------------------------------

describe('GET /episodes/:id/trail', () => {
  it('is unknown with fewer than two usable fixes, skipping fixless envelopes', async () => {
    const scene = await enrol();
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', CBD));
    await ingestOne(
      scene.ingestToken,
      envelope('UNLOCK_FAILED', { attemptNo: 1 }), // no location
    );

    const res = await getTrail(scene.accessToken, episodeId);
    expect(res.status).toBe(200);
    expect(res.body.trail.movement).toBe('unknown');
    expect(res.body.trail.points).toHaveLength(1);
    expect(res.body.trail.leftFamiliar).toBeNull();
  });

  it('classifies a phone attacked in one place as static', async () => {
    const scene = await enrol();
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', CBD));
    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', NEARBY));

    const res = await getTrail(scene.accessToken, episodeId);
    expect(res.body.trail.movement).toBe('static');
  });

  it('orders fixes by receipt, includes UNLOCK_FAILED locations, and classifies movement', async () => {
    const scene = await enrol();
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    await ingestOne(
      scene.ingestToken,
      envelope('UNLOCK_FAILED', {
        attemptNo: 1,
        location: { ...CBD, accuracyM: 10 },
      }),
    );
    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', AWAY));

    const res = await getTrail(scene.accessToken, episodeId);
    expect(res.body.trail.movement).toBe('moving');
    expect(res.body.trail.points).toHaveLength(2);
    const [first, second] = res.body.trail.points;
    expect(first).toMatchObject({
      source: 'UNLOCK_FAILED',
      ...CBD,
      accuracyM: 10,
      familiar: null,
    });
    expect(second).toMatchObject({ source: 'TRAIL_POINT', ...AWAY });
    expect(new Date(first.at).getTime()).toBeLessThanOrEqual(
      new Date(second.at).getTime(),
    );
  });

  it('annotates familiar places and reports the departure - the F3 sentence', async () => {
    const scene = await enrol();
    await addFamiliar(scene.accessToken, { label: 'home', ...CBD });
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', CBD));
    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', AWAY));

    const res = await getTrail(scene.accessToken, episodeId);
    expect(res.body.trail.movement).toBe('moving');
    const [atHome, gone] = res.body.trail.points;
    expect(atHome.familiar).toMatchObject({ label: 'home' });
    expect(gone.familiar).toBeNull();
    expect(res.body.trail.leftFamiliar).toMatchObject({ label: 'home' });
    expect(res.body.trail.leftFamiliar.at).toBe(gone.at);
  });

  it('never reports a departure for a static trail (boundary wobble is not a theft cue)', async () => {
    const scene = await enrol();
    // a tight 50m radius around home; NEARBY (~44m) is inside, but with the
    // radius this small a wobble outside must still not read as "left home"
    await addFamiliar(scene.accessToken, { label: 'home', ...CBD, radiusM: 50 });
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    await ingestOne(scene.ingestToken, envelope('TRAIL_POINT', CBD));
    // ~78m from CBD: outside the 50m familiar radius, inside the 150m static radius
    await ingestOne(
      scene.ingestToken,
      envelope('TRAIL_POINT', { lat: -1.2928, lng: 36.8219 }),
    );

    const res = await getTrail(scene.accessToken, episodeId);
    expect(res.body.trail.movement).toBe('static');
    expect(res.body.trail.leftFamiliar).toBeNull();
  });

  it("is not visible to another user's session", async () => {
    const scene = await enrol();
    const episodeId = await markStolen(scene.accessToken, scene.deviceId);

    const stranger = await registerUser({ email: 'mallory@tambo.app' });
    const res = await getTrail(stranger.accessToken, episodeId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('episode_not_found');
  });
});

// --- Familiar context in the first alert ------------------------------------------

describe('first alert familiar annotation', () => {
  it('says the last known location is near a familiar place - and still alerts', async () => {
    const scene = await enrol();
    await addFamiliar(scene.accessToken, { label: 'home', ...CBD });

    // a located failed attempt lands BEFORE the episode opens
    await ingestOne(
      scene.ingestToken,
      envelope('UNLOCK_FAILED', { attemptNo: 1, location: CBD }),
    );
    await markStolen(scene.accessToken, scene.deviceId);

    // the alert is fire-and-forget; poll for it
    let alert;
    for (let i = 0; i < 100 && !alert; i += 1) {
      alert = noopMailer.sent.find((mail) =>
        mail.subject.includes('may be stolen'),
      );
      if (!alert) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(alert).toBeDefined();
    expect(alert?.text).toContain('near familiar location "home"');
  });
});
