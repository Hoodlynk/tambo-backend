import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import Device from '../src/models/device.model';
import Partner from '../src/models/partner.model';
import PartnerApiKey from '../src/models/partnerApiKey.model';
import User from '../src/models/user.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { CREDENTIALS, registerUser, startRegister } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
});
afterAll(closeTestDb);

const auth = (token: string) => `Bearer ${token}`;

const until = async (predicate: () => Promise<boolean> | boolean) => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
};

const ACME = {
  code: 'acme',
  name: 'Acme Insurance',
  type: 'insurer',
  brand: {
    displayName: 'Acme Protect',
    logoUrl: 'https://acme.example/logo.png',
    colors: { primary: '#0a7f3f', onPrimary: '#ffffff' },
    supportEmail: 'help@acme.example',
  },
};

/** An admin's access token; the role lives in the JWT, so log in after the flip. */
const adminToken = async (): Promise<string> => {
  const admin = await registerUser({ email: 'admin@tambo.app' });
  await User.updateOne({ _id: admin.userId }, { $set: { role: 'admin' } });
  const res = await request(testServer())
    .post('/api/v1/auth/login')
    .send({ email: 'admin@tambo.app', password: CREDENTIALS.password });
  return res.body.tokens.accessToken as string;
};

const createPartner = async (
  token: string,
  body: Record<string, unknown> = ACME,
) => {
  const res = await request(testServer())
    .post('/api/v1/admin/partners')
    .set('Authorization', auth(token))
    .send(body);
  if (res.status !== 201) {
    throw new Error(`createPartner: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.partner as { _id: string; code: string };
};

const issueKey = async (token: string, partnerId: string) => {
  const res = await request(testServer())
    .post(`/api/v1/admin/partners/${partnerId}/keys`)
    .set('Authorization', auth(token))
    .send({ name: 'Claims system' });
  return res;
};

const enrol = (accessToken: string, extra: Record<string, unknown> = {}) =>
  request(testServer())
    .post('/api/v1/devices')
    .set('Authorization', auth(accessToken))
    .send({
      name: 'P',
      imeis: ['356938035643809'],
      make: 'Tecno',
      deviceModel: 'Spark',
      ...extra,
    });

describe('admin partner catalogue', () => {
  it('is admin-only', async () => {
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .get('/api/v1/admin/partners')
      .set('Authorization', auth(accessToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('creates a partner with every feature on by default and normalized values', async () => {
    const token = await adminToken();
    const partner = await createPartner(token, { ...ACME, code: ' ACME ' });
    expect(partner).toMatchObject({
      code: 'acme',
      status: 'active',
      type: 'insurer',
      brand: { colors: { primary: '#0A7F3F', onPrimary: '#FFFFFF' } },
      features: { buddies: true, plans: true, familiarLocations: true },
      alertRecipients: [],
    });

    const list = await request(testServer())
      .get('/api/v1/admin/partners')
      .set('Authorization', auth(token));
    expect(list.body.partners).toHaveLength(1);
  });

  it('refuses a duplicate code and a non-https logo', async () => {
    const token = await adminToken();
    await createPartner(token);
    const dup = await request(testServer())
      .post('/api/v1/admin/partners')
      .set('Authorization', auth(token))
      .send({ ...ACME, name: 'Other' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('partner_code_taken');

    const insecure = await request(testServer())
      .post('/api/v1/admin/partners')
      .set('Authorization', auth(token))
      .send({
        ...ACME,
        code: 'other',
        brand: { ...ACME.brand, logoUrl: 'http://acme.example/logo.png' },
      });
    expect(insecure.status).toBe(400);
  });

  it('patches flag by flag, clears the default plan with null, and never changes the code', async () => {
    const token = await adminToken();
    const partner = await createPartner(token, {
      ...ACME,
      defaultPlan: 'pro',
    });

    const res = await request(testServer())
      .patch(`/api/v1/admin/partners/${partner._id}`)
      .set('Authorization', auth(token))
      .send({ features: { buddies: false }, defaultPlan: null, code: 'evil' });
    expect(res.status).toBe(200);
    expect(res.body.partner.code).toBe('acme');
    expect(res.body.partner.features).toEqual({
      buddies: false,
      plans: true,
      familiarLocations: true,
    });
    expect(res.body.partner.defaultPlan).toBeUndefined();

    // a body carrying only the immutable code is an empty patch
    const codeOnly = await request(testServer())
      .patch(`/api/v1/admin/partners/${partner._id}`)
      .set('Authorization', auth(token))
      .send({ code: 'evil' });
    expect(codeOnly.status).toBe(400);
  });

  it('404s an unknown partner', async () => {
    const token = await adminToken();
    const res = await request(testServer())
      .get('/api/v1/admin/partners/aaaaaaaaaaaaaaaaaaaaaaaa')
      .set('Authorization', auth(token));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('partner_not_found');
  });
});

describe('partner API keys', () => {
  it('issues a key once, stores only its hash, and authenticates partner routes', async () => {
    const token = await adminToken();
    const partner = await createPartner(token);
    const issued = await issueKey(token, partner._id);
    expect(issued.status).toBe(201);
    const apiKey = issued.body.apiKey as string;
    expect(apiKey).toMatch(/^tpk_/);
    expect(apiKey.startsWith(issued.body.key.prefix)).toBe(true);

    const stored = await PartnerApiKey.findOne().select('+keyHash').lean();
    expect(stored?.keyHash).not.toContain(apiKey);

    const list = await request(testServer())
      .get(`/api/v1/admin/partners/${partner._id}/keys`)
      .set('Authorization', auth(token));
    expect(JSON.stringify(list.body)).not.toContain(apiKey);
    expect(list.body.keys[0]).toMatchObject({ revokedAt: null });

    const me = await request(testServer())
      .get('/api/v1/partner/me')
      .set('X-Api-Key', apiKey);
    expect(me.status).toBe(200);
    expect(me.body.partner).toEqual({
      code: 'acme',
      name: 'Acme Insurance',
      type: 'insurer',
    });

    await until(async () =>
      Boolean((await PartnerApiKey.findOne())?.lastUsedAt),
    );
  });

  it('rejects a missing key, an unknown key, and a user JWT', async () => {
    const { accessToken } = await registerUser();
    const missing = await request(testServer()).get('/api/v1/partner/me');
    expect(missing.status).toBe(401);
    expect(missing.body.code).toBe('missing_api_key');

    const unknown = await request(testServer())
      .get('/api/v1/partner/me')
      .set('X-Api-Key', 'tpk_nope');
    expect(unknown.body.code).toBe('invalid_api_key');

    const jwt = await request(testServer())
      .get('/api/v1/partner/me')
      .set('Authorization', auth(accessToken));
    expect(jwt.body.code).toBe('missing_api_key');
  });

  it('a revoked key stops working, and revoking again is a no-op', async () => {
    const token = await adminToken();
    const partner = await createPartner(token);
    const issued = await issueKey(token, partner._id);
    const path = `/api/v1/admin/partners/${partner._id}/keys/${issued.body.key.id}`;

    const revoke = await request(testServer())
      .delete(path)
      .set('Authorization', auth(token));
    expect(revoke.status).toBe(204);
    const again = await request(testServer())
      .delete(path)
      .set('Authorization', auth(token));
    expect(again.status).toBe(204);

    const me = await request(testServer())
      .get('/api/v1/partner/me')
      .set('X-Api-Key', issued.body.apiKey);
    expect(me.status).toBe(401);
    expect(me.body.code).toBe('invalid_api_key');
  });

  it("a key cannot be revoked through another partner's path", async () => {
    const token = await adminToken();
    const acme = await createPartner(token);
    const other = await createPartner(token, { ...ACME, code: 'other' });
    const issued = await issueKey(token, acme._id);
    const res = await request(testServer())
      .delete(`/api/v1/admin/partners/${other._id}/keys/${issued.body.key.id}`)
      .set('Authorization', auth(token));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('partner_key_not_found');
  });

  it('suspending a partner disables its keys', async () => {
    const token = await adminToken();
    const partner = await createPartner(token);
    const issued = await issueKey(token, partner._id);
    await request(testServer())
      .patch(`/api/v1/admin/partners/${partner._id}`)
      .set('Authorization', auth(token))
      .send({ status: 'suspended' });

    const me = await request(testServer())
      .get('/api/v1/partner/me')
      .set('X-Api-Key', issued.body.apiKey);
    expect(me.status).toBe(401);
  });
});

describe('GET /api/v1/client/config', () => {
  const original = { ...config.clientVersions.android };
  afterEach(() => {
    config.clientVersions.android = { ...original };
  });

  it('serves the Tambo brand and every feature to an unbranded build', async () => {
    const res = await request(testServer()).get(
      '/api/v1/client/config?platform=android',
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age=300');
    expect(res.body.config).toMatchObject({
      platform: 'android',
      partner: null,
      brand: {
        displayName: 'Tambo',
        colors: { primary: '#1D28D6', onPrimary: '#FFFFFF' },
      },
      features: { buddies: true, plans: true, familiarLocations: true },
      versions: { update: 'unknown' },
    });
  });

  it('requires a known platform', async () => {
    const res = await request(testServer()).get('/api/v1/client/config');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });

  it("serves a partner's brand and flags, and keeps serving them once suspended", async () => {
    const token = await adminToken();
    const partner = await createPartner(token, {
      ...ACME,
      features: { buddies: false },
    });

    const res = await request(testServer()).get(
      '/api/v1/client/config?platform=ios&partner=ACME',
    );
    expect(res.status).toBe(200);
    expect(res.body.config).toMatchObject({
      platform: 'ios',
      partner: { code: 'acme', type: 'insurer' },
      brand: {
        displayName: 'Acme Protect',
        logoUrl: 'https://acme.example/logo.png',
        colors: { primary: '#0A7F3F' },
        supportEmail: 'help@acme.example',
        supportUrl: null,
      },
      features: { buddies: false, plans: true },
    });

    await Partner.updateOne({ _id: partner._id }, { status: 'suspended' });
    const suspended = await request(testServer()).get(
      '/api/v1/client/config?platform=ios&partner=acme',
    );
    expect(suspended.status).toBe(200);
    expect(suspended.body.config.brand.displayName).toBe('Acme Protect');
  });

  it('404s an unknown partner code', async () => {
    const res = await request(testServer()).get(
      '/api/v1/client/config?platform=android&partner=nobody',
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown_partner');
  });

  it('advises an update against X-Client-Version, numerically', async () => {
    config.clientVersions.android = {
      minimum: '1.9.0',
      recommended: '1.10.0',
    };
    const advice = async (version: string) =>
      (
        await request(testServer())
          .get('/api/v1/client/config?platform=android')
          .set('X-Client-Version', version)
      ).body.config.versions.update;

    expect(await advice('1.8.9')).toBe('required');
    expect(await advice('1.9.5')).toBe('recommended');
    expect(await advice('1.10.0')).toBe('none');
    // a malformed header is ignored, not trusted
    expect(await advice('banana')).toBe('unknown');
  });
});

describe('partnerCode at signup', () => {
  it('joins the partner and takes its default plan as a partner-paid plan', async () => {
    const token = await adminToken();
    await createPartner(token, { ...ACME, defaultPlan: 'pro' });

    const { accessToken, userId } = await registerUser({
      email: 'customer@acme.example',
      partnerCode: 'Acme',
    });
    const user = await User.findById(userId);
    expect(user?.partner).toBeDefined();
    expect(user?.planSource).toBe('partner');

    const plan = await request(testServer())
      .get('/api/v1/plan')
      .set('Authorization', auth(accessToken));
    expect(plan.body.plan).toMatchObject({
      plan: 'pro',
      effectivePlan: 'pro',
      source: 'partner',
    });
  });

  it('a partner without a default plan leaves the account free and self-paid', async () => {
    const token = await adminToken();
    await createPartner(token);
    const { userId } = await registerUser({
      email: 'c@acme.example',
      partnerCode: 'acme',
    });
    const user = await User.findById(userId);
    expect(user?.partner).toBeDefined();
    expect(user?.plan).toBe('free');
    expect(user?.planSource).toBe('self');
  });

  it('refuses an unknown or suspended code before creating anything', async () => {
    const token = await adminToken();
    const partner = await createPartner(token);
    await Partner.updateOne({ _id: partner._id }, { status: 'suspended' });

    for (const partnerCode of ['nobody', 'acme']) {
      const res = await startRegister({
        email: `${partnerCode}@x.example`,
        partnerCode,
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('unknown_partner');
    }
    expect(await User.countDocuments()).toBe(1); // the admin only
  });

  it('a superseding signup re-decides the partner of an abandoned one', async () => {
    const token = await adminToken();
    await createPartner(token, { ...ACME, defaultPlan: 'pro' });
    await startRegister({ email: 'z@x.example', partnerCode: 'acme' });
    await startRegister({ email: 'z@x.example' });

    const user = await User.findOne({ email: 'z@x.example' });
    expect(user?.partner).toBeUndefined();
    expect(user?.plan).toBe('free');
    expect(user?.planSource).toBe('self');
  });
});

describe('partnerCode at device enrolment', () => {
  it("inherits the owner's partner, or takes an explicit one", async () => {
    const token = await adminToken();
    const acme = await createPartner(token);
    await createPartner(token, { ...ACME, code: 'fleet', type: 'enterprise' });

    const owner = await registerUser({
      email: 'o@acme.example',
      partnerCode: 'acme',
    });
    const inherited = await enrol(owner.accessToken);
    expect(inherited.status).toBe(201);
    expect(inherited.body.device.partner).toBe(acme._id);

    await Device.deleteMany({});
    const explicit = await enrol(owner.accessToken, { partnerCode: 'fleet' });
    expect(explicit.status).toBe(201);
    expect(explicit.body.device.partner).not.toBe(acme._id);
  });

  it('a plain owner enrols a plain device; an unknown code is refused', async () => {
    const { accessToken } = await registerUser();
    const bad = await enrol(accessToken, { partnerCode: 'nobody' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('unknown_partner');

    const plain = await enrol(accessToken);
    expect(plain.status).toBe(201);
    expect(plain.body.device.partner).toBeUndefined();
  });

  it('the partner is fixed at enrolment: updates ignore partnerCode', async () => {
    const { accessToken } = await registerUser();
    const device = await enrol(accessToken);
    const res = await request(testServer())
      .patch(`/api/v1/devices/${device.body.device._id}`)
      .set('Authorization', auth(accessToken))
      .send({ partnerCode: 'acme' });
    expect(res.status).toBe(400);
  });
});

describe('admin plan source', () => {
  it('records who pays', async () => {
    const token = await adminToken();
    const { userId, accessToken } = await registerUser();
    const set = await request(testServer())
      .patch(`/api/v1/plan/${userId}`)
      .set('Authorization', auth(token))
      .send({ plan: 'family', source: 'partner' });
    expect(set.status).toBe(200);
    expect(set.body.plan.source).toBe('partner');

    const back = await request(testServer())
      .patch(`/api/v1/plan/${userId}`)
      .set('Authorization', auth(token))
      .send({ plan: 'pro' });
    expect(back.body.plan.source).toBe('self');

    const own = await request(testServer())
      .get('/api/v1/plan')
      .set('Authorization', auth(accessToken));
    expect(own.body.plan.source).toBe('self');
  });
});

describe('X-Client-* headers on sessions', () => {
  const sessions = async (accessToken: string) =>
    (
      await request(testServer())
        .get('/api/v1/auth/sessions')
        .set('Authorization', auth(accessToken))
    ).body.sessions as {
      clientPlatform: string | null;
      clientVersion: string | null;
    }[];

  it('records platform and version at login and moves them on refresh', async () => {
    await registerUser();
    const login = await request(testServer())
      .post('/api/v1/auth/login')
      .set('X-Client-Platform', 'Android')
      .set('X-Client-Version', '1.4.0')
      .send({ email: CREDENTIALS.email, password: CREDENTIALS.password });
    expect(login.status).toBe(200);

    // a refresh with no headers keeps what the lineage reported
    const quiet = await request(testServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.tokens.refreshToken });
    const afterQuiet = await sessions(quiet.body.tokens.accessToken);
    expect(afterQuiet).toContainEqual(
      expect.objectContaining({
        clientPlatform: 'android',
        clientVersion: '1.4.0',
      }),
    );

    // an upgraded build reports its new version
    const upgraded = await request(testServer())
      .post('/api/v1/auth/refresh')
      .set('X-Client-Version', '1.5.0')
      .send({ refreshToken: quiet.body.tokens.refreshToken });
    const afterUpgrade = await sessions(upgraded.body.tokens.accessToken);
    expect(afterUpgrade).toContainEqual(
      expect.objectContaining({
        clientPlatform: 'android',
        clientVersion: '1.5.0',
      }),
    );
  });

  it('ignores malformed headers instead of rejecting the request', async () => {
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .get('/api/v1/auth/me')
      .set('Authorization', auth(accessToken))
      .set('X-Client-Platform', 'symbian')
      .set('X-Client-Version', 'latest');
    expect(res.status).toBe(200);

    const list = await sessions(accessToken);
    expect(list[0]).toMatchObject({
      clientPlatform: null,
      clientVersion: null,
    });
  });
});
