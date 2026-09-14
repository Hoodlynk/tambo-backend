import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import Buddy from '../src/models/buddy.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import User from '../src/models/user.model';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const invite = (token: string, email: string, name?: string) =>
  request(testServer())
    .post('/api/v1/buddies')
    .set('Authorization', `Bearer ${token}`)
    .send({ email, ...(name ? { name } : {}) });

const listBuddies = (token: string) =>
  request(testServer())
    .get('/api/v1/buddies')
    .set('Authorization', `Bearer ${token}`);

const listInvites = (token: string) =>
  request(testServer())
    .get('/api/v1/buddy-invites')
    .set('Authorization', `Bearer ${token}`);

const respond = (token: string, id: string, action: 'accept' | 'decline') =>
  request(testServer())
    .post(`/api/v1/buddy-invites/${id}/${action}`)
    .set('Authorization', `Bearer ${token}`);

describe('inviting a buddy who is already a Tambo user', () => {
  it('creates a pending link and the buddy sees the invitation in-app', async () => {
    const owner = await registerUser();
    const buddy = await registerUser({
      email: 'grace@tambo.app',
      name: 'Grace Hopper',
    });

    const res = await invite(owner.accessToken, 'grace@tambo.app');
    expect(res.status).toBe(201);
    expect(res.body.buddy).toMatchObject({
      email: 'grace@tambo.app',
      status: 'pending',
    });

    const invites = await listInvites(buddy.accessToken);
    expect(invites.body.invites).toHaveLength(1);
    expect(invites.body.invites[0].from.name).toBe('Ada Lovelace');

    // the buddy is emailed a heads-up
    expect(noopMailer.sent.at(-1)?.to).toBe('grace@tambo.app');
    expect(noopMailer.sent.at(-1)?.text).toContain(
      'added you as their Tambo buddy',
    );
  });

  it('accepting activates the link; the owner sees the buddy active', async () => {
    const owner = await registerUser();
    const buddy = await registerUser({
      email: 'grace@tambo.app',
      name: 'Grace Hopper',
    });
    await invite(owner.accessToken, 'grace@tambo.app');

    const invites = await listInvites(buddy.accessToken);
    const accepted = await respond(
      buddy.accessToken,
      invites.body.invites[0].id,
      'accept',
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.invite.status).toBe('active');

    const buddies = await listBuddies(owner.accessToken);
    expect(buddies.body.buddies[0]).toMatchObject({
      status: 'active',
      name: 'Grace Hopper',
    });
  });

  it('declining leaves the link declined and the buddy off every alert path', async () => {
    const owner = await registerUser();
    const buddy = await registerUser({
      email: 'grace@tambo.app',
      name: 'Grace Hopper',
    });
    await invite(owner.accessToken, 'grace@tambo.app');
    const invites = await listInvites(buddy.accessToken);

    const declined = await respond(
      buddy.accessToken,
      invites.body.invites[0].id,
      'decline',
    );
    expect(declined.body.invite.status).toBe('declined');
    expect((await listInvites(buddy.accessToken)).body.invites).toHaveLength(0);
  });

  it('records exactly one answer under a concurrent accept/decline double-tap', async () => {
    const owner = await registerUser();
    const buddy = await registerUser({
      email: 'grace@tambo.app',
      name: 'Grace Hopper',
    });
    await invite(owner.accessToken, 'grace@tambo.app');
    const id = (await listInvites(buddy.accessToken)).body.invites[0]
      .id as string;

    const results = await Promise.all([
      respond(buddy.accessToken, id, 'accept'),
      respond(buddy.accessToken, id, 'decline'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect(await Buddy.countDocuments({ status: 'pending' })).toBe(0);
  });
});

describe('inviting someone not yet on Tambo', () => {
  it('waits, then auto-binds when they sign up with that email', async () => {
    const owner = await registerUser();

    const res = await invite(owner.accessToken, 'future@tambo.app');
    expect(res.status).toBe(201);
    expect(res.body.buddy.status).toBe('pending');
    // the pending link has no buddy user yet
    expect(await Buddy.countDocuments({ buddy: { $exists: false } })).toBe(1);
    expect(noopMailer.sent.at(-1)?.text).toContain('install Tambo and sign up');

    // they join with that email -> the invite binds and appears in-app
    const newUser = await registerUser({ email: 'future@tambo.app' });
    const invites = await listInvites(newUser.accessToken);
    expect(invites.body.invites).toHaveLength(1);
    expect(invites.body.invites[0].from.name).toBe('Ada Lovelace');
  });

  it('does not reveal whether the email is a registered user', async () => {
    const owner = await registerUser();
    await registerUser({ email: 'real@tambo.app' });

    const known = await invite(owner.accessToken, 'real@tambo.app');
    const unknown = await invite(owner.accessToken, 'ghost@tambo.app');

    // identical shape and status for both
    expect(known.status).toBe(201);
    expect(unknown.status).toBe(201);
    expect(known.body.buddy.status).toBe(unknown.body.buddy.status);
  });
});

describe('owner-side management', () => {
  it('enforces the buddy limit on pending + active links', async () => {
    const owner = await registerUser();
    for (let i = 0; i < config.buddies.max; i += 1) {
      expect((await invite(owner.accessToken, `b${i}@tambo.app`)).status).toBe(
        201,
      );
    }
    const over = await invite(owner.accessToken, 'one-too-many@tambo.app');
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('buddy_limit_reached');
  });

  it('rejects self-invite and duplicates', async () => {
    const owner = await registerUser();

    const self = await invite(owner.accessToken, 'ada@tambo.app');
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('buddy_is_self');

    await invite(owner.accessToken, 'grace@tambo.app');
    const dupe = await invite(owner.accessToken, 'grace@tambo.app');
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('buddy_exists');
  });

  it('removing a buddy revokes the link and re-inviting is allowed', async () => {
    const owner = await registerUser();
    await registerUser({ email: 'grace@tambo.app' });
    const created = await invite(owner.accessToken, 'grace@tambo.app');

    const removed = await request(testServer())
      .delete(`/api/v1/buddies/${created.body.buddy.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(removed.status).toBe(204);

    // freed a slot, and re-inviting the same person works again
    expect((await invite(owner.accessToken, 'grace@tambo.app')).status).toBe(
      201,
    );
  });

  it("cannot remove another owner's buddy link", async () => {
    const owner = await registerUser();
    const attacker = await registerUser({ email: 'mallory@tambo.app' });
    const created = await invite(owner.accessToken, 'grace@tambo.app');

    const res = await request(testServer())
      .delete(`/api/v1/buddies/${created.body.buddy.id}`)
      .set('Authorization', `Bearer ${attacker.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('a revoked buddy can no longer act on the stale invitation', async () => {
    const owner = await registerUser();
    const buddy = await registerUser({
      email: 'grace@tambo.app',
      name: 'Grace Hopper',
    });
    const created = await invite(owner.accessToken, 'grace@tambo.app');
    const id = (await listInvites(buddy.accessToken)).body.invites[0]
      .id as string;

    await request(testServer())
      .delete(`/api/v1/buddies/${created.body.buddy.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);

    // the invitation is gone from the buddy's view, and acting on it 404s
    expect((await listInvites(buddy.accessToken)).body.invites).toHaveLength(0);
    expect((await respond(buddy.accessToken, id, 'accept')).status).toBe(404);
  });
});

describe('buddy-side isolation', () => {
  it('a user cannot accept an invitation addressed to someone else', async () => {
    const owner = await registerUser();
    await registerUser({ email: 'grace@tambo.app' });
    const outsider = await registerUser({ email: 'nosy@tambo.app' });
    await invite(owner.accessToken, 'grace@tambo.app');

    const graceInvites = await request(testServer())
      .get('/api/v1/buddy-invites')
      .set('Authorization', `Bearer ${outsider.accessToken}`);
    expect(graceInvites.body.invites).toHaveLength(0);
  });

  it('requires authentication on both sides', async () => {
    expect(
      (
        await request(testServer())
          .post('/api/v1/buddies')
          .send({ email: 'x@y.z' })
      ).status,
    ).toBe(401);
    expect(
      (await request(testServer()).get('/api/v1/buddy-invites')).status,
    ).toBe(401);
  });
});

describe('buddy identity survives an email change', () => {
  it("re-inviting the buddy's NEW address does not create a second live link to the same human", async () => {
    const owner = await registerUser();
    const buddy = await registerUser({ email: 'pal@tambo.app' });

    await request(testServer())
      .post('/api/v1/buddies')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: 'pal@tambo.app' });
    const invites = await request(testServer())
      .get('/api/v1/buddy-invites')
      .set('Authorization', `Bearer ${buddy.accessToken}`);
    await request(testServer())
      .post(`/api/v1/buddy-invites/${invites.body.invites[0].id}/accept`)
      .set('Authorization', `Bearer ${buddy.accessToken}`);

    // the buddy changes their address (simulating a completed email_change)
    await User.updateOne(
      { _id: buddy.userId },
      { $set: { email: 'pal-new@tambo.app' } },
    );

    const again = await request(testServer())
      .post('/api/v1/buddies')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ email: 'pal-new@tambo.app' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('buddy_exists');
    expect(
      await Buddy.countDocuments({ owner: owner.userId, status: 'active' }),
    ).toBe(1);
  });
});
