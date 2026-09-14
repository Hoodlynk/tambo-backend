import request from 'supertest';
import { testServer } from './setup/testServer';
import { SEED_EMAIL, seed } from '../scripts/seed-dev';
import Device from '../src/models/device.model';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

describe('scripts/seed-dev', () => {
  it('produces a working owner: session, device, open episode, trail, pack', async () => {
    const seeded = await seed();
    const auth = { Authorization: `Bearer ${seeded.accessToken}` };

    const episodes = await request(testServer())
      .get('/api/v1/episodes')
      .set(auth);
    expect(episodes.status).toBe(200);
    expect(episodes.body.episodes).toHaveLength(1);
    const episodeId = episodes.body.episodes[0]._id as string;
    expect(episodes.body.episodes[0].status).toBe('open');

    const trail = await request(testServer())
      .get(`/api/v1/episodes/${episodeId}/trail`)
      .set(auth);
    expect(trail.body.trail.movement).toBe('moving');
    expect(trail.body.trail.points.length).toBeGreaterThanOrEqual(4);

    const pack = await request(testServer())
      .get(`/api/v1/episodes/${episodeId}/pack`)
      .set(auth);
    expect(pack.status).toBe(200);
    expect(pack.body.pack.unlockAttempts).toHaveLength(1);

    // re-running replaces the ENTIRE footprint, never duplicates it
    const again = await seed();
    expect(again.userId).not.toBe(seeded.userId);
    expect(await User.countDocuments({ email: SEED_EMAIL })).toBe(1);
    expect(await Device.countDocuments({})).toBe(1); // no orphaned device
    expect(await Device.countDocuments({ user: seeded.userId })).toBe(0);
    const relisted = await request(testServer())
      .get('/api/v1/episodes')
      .set({ Authorization: `Bearer ${again.accessToken}` });
    expect(relisted.body.episodes).toHaveLength(1);
  });
});
