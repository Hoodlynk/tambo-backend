import crypto from 'crypto';
import { Types } from 'mongoose';
import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import Device from '../src/models/device.model';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import PackDelivery from '../src/models/packDelivery.model';
import Partner from '../src/models/partner.model';
import PartnerApiKey from '../src/models/partnerApiKey.model';
import TheftEpisode from '../src/models/theftEpisode.model';
import { integrityVerifier } from '../src/services/integrity';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { claimRequestHash } from '../src/services/provisioning.service';
import { hashOpaqueToken, sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
  jest.restoreAllMocks();
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

const IMEI_A = '356938035643809';
const IMEI_B = '356938035643817';
const INSTALL = 'install-0123456789abcdef';

/** A partner and a live API key, written straight to the models. */
const partnerWithKey = async (
  overrides: Record<string, unknown> = {},
): Promise<{ partnerId: string; apiKey: string }> => {
  const partner = await Partner.create({
    code: `p${crypto.randomBytes(4).toString('hex')}`,
    name: 'Acme Phones',
    type: 'oem',
    brand: {
      displayName: 'Acme',
      colors: { primary: '#0A7F3F', onPrimary: '#FFFFFF' },
    },
    alertRecipients: [{ email: 'ops@acme.example', name: 'Ops desk' }],
    ...overrides,
  });
  const apiKey = `tpk_${crypto.randomBytes(32).toString('base64url')}`;
  await PartnerApiKey.create({
    partner: partner._id,
    name: 'Factory',
    prefix: apiKey.slice(0, 12),
    keyHash: hashOpaqueToken(apiKey),
    createdBy: new Types.ObjectId(),
  });
  return { partnerId: partner._id.toString(), apiKey };
};

const provision = (apiKey: string, devices: object[]) =>
  request(testServer())
    .post('/api/v1/partner/devices')
    .set('X-Api-Key', apiKey)
    .send({ devices });

const handset = (imeis = [IMEI_A], extra: object = {}) => ({
  imeis,
  make: 'Tecno',
  deviceModel: 'Spark 20',
  ...extra,
});

const claim = (provisioningToken: string, extra: object = {}) =>
  request(testServer())
    .post('/api/v1/devices/claim')
    .send({ provisioningToken, installId: INSTALL, ...extra });

const link = (
  accessToken: string,
  deviceId: string,
  ingestToken: string,
  body: object = {},
) =>
  request(testServer())
    .post(`/api/v1/devices/${deviceId}/link`)
    .set('Authorization', auth(accessToken))
    .set('X-Device-Token', ingestToken)
    .send(body);

let seq = 0;
const envelope = (type = 'UNLOCK_FAILED', payloadObj: object = {}) => {
  const payload = JSON.stringify(payloadObj);
  seq += 1;
  return {
    id: `prov-${Date.now()}-${seq}`,
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

/** Provision one handset and claim it: the phone, protecting, with no owner. */
const claimedPhone = async (partnerOverrides: Record<string, unknown> = {}) => {
  const { partnerId, apiKey } = await partnerWithKey(partnerOverrides);
  const provisioned = await provision(apiKey, [handset()]);
  const claimed = await claim(provisioned.body.devices[0].provisioningToken);
  if (claimed.status !== 201) {
    throw new Error(`claim: ${claimed.status} ${JSON.stringify(claimed.body)}`);
  }
  return {
    partnerId,
    apiKey,
    deviceId: claimed.body.device._id as string,
    ingestToken: claimed.body.ingestToken as string,
  };
};

const openByThreshold = async (ingestToken: string) => {
  const res = await ingest(ingestToken, [envelope(), envelope(), envelope()]);
  expect(res.body.episodeOpened).toBe(true);
  return res;
};

describe('POST /api/v1/partner/devices (provisioning)', () => {
  it('needs a partner API key', async () => {
    const res = await request(testServer())
      .post('/api/v1/partner/devices')
      .send({ devices: [handset()] });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_api_key');
  });

  it('creates ownerless partner devices, one single-use token each', async () => {
    const { partnerId, apiKey } = await partnerWithKey();
    const res = await provision(apiKey, [
      handset([IMEI_A], { serial: 'SN-1' }),
      handset([IMEI_B], { name: 'Shop demo' }),
    ]);

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(2);
    expect(res.body.devices[0]).toMatchObject({
      imeis: [IMEI_A],
      serial: 'SN-1',
      status: 'provisioned',
    });
    expect(res.body.devices[0].provisioningToken).toEqual(expect.any(String));

    const stored = await Device.findById(res.body.devices[0].deviceId).select(
      '+provisioningTokenHash',
    );
    expect(stored!.user).toBeUndefined();
    expect(stored!.partner!.toString()).toBe(partnerId);
    expect(stored!.name).toBe('Tecno Spark 20');
    expect(stored!.provisioningTokenHash).toBe(
      hashOpaqueToken(res.body.devices[0].provisioningToken),
    );
    const named = await Device.findById(res.body.devices[1].deviceId);
    expect(named!.name).toBe('Shop demo');
  });

  it('reissues an unclaimed handset instead of minting a second device', async () => {
    const { apiKey } = await partnerWithKey();
    const first = await provision(apiKey, [handset()]);
    const again = await provision(apiKey, [handset([IMEI_B, IMEI_A])]);

    expect(again.body.devices[0]).toMatchObject({
      deviceId: first.body.devices[0].deviceId,
      status: 'reissued',
    });
    expect(await Device.countDocuments()).toBe(1);
    // the factory's earlier token is dead
    expect((await claim(first.body.devices[0].provisioningToken)).status).toBe(
      401,
    );
    expect((await claim(again.body.devices[0].provisioningToken)).status).toBe(
      201,
    );
  });

  it('reports a claimed handset without issuing a token', async () => {
    const { apiKey, deviceId } = await claimedPhone();
    const res = await provision(apiKey, [handset()]);
    expect(res.body.devices[0]).toEqual({
      deviceId,
      imeis: [IMEI_A],
      serial: null,
      status: 'claimed',
    });
  });

  it('keeps partners apart: the same IMEI under another partner is its own device', async () => {
    const one = await partnerWithKey();
    const two = await partnerWithKey();
    await provision(one.apiKey, [handset()]);
    const res = await provision(two.apiKey, [handset()]);
    expect(res.body.devices[0].status).toBe('provisioned');
    expect(await Device.countDocuments()).toBe(2);
  });

  it('refuses an IMEI repeated within one call', async () => {
    const { apiKey } = await partnerWithKey();
    const res = await provision(apiKey, [handset(), handset([IMEI_A])]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });
});

describe('POST /api/v1/devices/claim', () => {
  it('trades the provisioning token for an ingest token that uploads with no owner', async () => {
    const { ingestToken, deviceId } = await claimedPhone();

    const stored = await Device.findById(deviceId);
    expect(stored!.claimedAt).toBeInstanceOf(Date);
    expect(stored!.user).toBeUndefined();

    const res = await ingest(ingestToken, [envelope('TRAIL_POINT')]);
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('acked');
    const row = await EvidenceEnvelope.findOne({ device: deviceId });
    expect(row!.user).toBeUndefined();
  });

  it('lets the same install retry a lost response, rotating the ingest token', async () => {
    const { apiKey } = await partnerWithKey();
    const token = (await provision(apiKey, [handset()])).body.devices[0]
      .provisioningToken;
    const first = await claim(token);
    const retry = await claim(token);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.ingestToken).not.toBe(first.body.ingestToken);
    expect((await ingest(first.body.ingestToken, [envelope()])).status).toBe(
      401,
    );
    expect((await ingest(retry.body.ingestToken, [envelope()])).status).toBe(
      200,
    );
  });

  it('refuses any other install', async () => {
    const { apiKey } = await partnerWithKey();
    const token = (await provision(apiKey, [handset()])).body.devices[0]
      .provisioningToken;
    await claim(token);
    const res = await claim(token, { installId: 'another-install-0000' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_already_claimed');
  });

  it('answers an unknown token and a suspended partner alike', async () => {
    const unknown = await claim('x'.repeat(40));
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('invalid_provisioning_token');

    const { partnerId, apiKey } = await partnerWithKey();
    const token = (await provision(apiKey, [handset()])).body.devices[0]
      .provisioningToken;
    await Partner.updateOne({ _id: partnerId }, { status: 'suspended' });
    const suspended = await claim(token);
    expect(suspended.status).toBe(401);
    expect(suspended.body.code).toBe('invalid_provisioning_token');
  });

  describe('with Play Integrity required', () => {
    const original = config.claim.integrity;
    beforeEach(() => {
      config.claim.integrity = 'required';
    });
    afterEach(() => {
      config.claim.integrity = original;
    });

    const freshToken = async () => {
      const { apiKey } = await partnerWithKey();
      return (await provision(apiKey, [handset()])).body.devices[0]
        .provisioningToken as string;
    };

    it('requires an integrity token', async () => {
      const res = await claim(await freshToken());
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('integrity_required');
    });

    it('refuses a verdict the verifier rejects, and leaves the phone claimable', async () => {
      const token = await freshToken();
      const res = await claim(token, { integrityToken: 'forged' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('integrity_failed');
      expect(await Device.exists({ claimedAt: { $exists: true } })).toBeNull();
    });

    it('accepts a verdict bound to this claim', async () => {
      const verify = jest
        .spyOn(integrityVerifier, 'verify')
        .mockResolvedValue(true);
      const token = await freshToken();
      const res = await claim(token, { integrityToken: 'genuine' });
      expect(res.status).toBe(201);
      expect(verify).toHaveBeenCalledWith(
        'genuine',
        claimRequestHash(token, INSTALL),
      );
    });
  });
});

describe('POST /api/v1/devices/:id/link', () => {
  it('needs both the session and the phone’s device token', async () => {
    const { deviceId } = await claimedPhone();
    const { accessToken } = await registerUser();
    const res = await request(testServer())
      .post(`/api/v1/devices/${deviceId}/link`)
      .set('Authorization', auth(accessToken))
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_device_token');
  });

  it('is legal-gated like enrolment', async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    const { accessToken } = await registerUser({}, { acceptLegal: false });
    const res = await link(accessToken, deviceId, ingestToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('legal_acceptance_required');
  });

  it('links the phone, hands over its history, and is idempotent', async () => {
    const { deviceId, ingestToken, apiKey } = await claimedPhone();
    // an ownerless history: routine evidence, and an episode the partner closed
    await ingest(ingestToken, [envelope('TRAIL_POINT')]);
    await openByThreshold(ingestToken);
    await request(testServer())
      .post(`/api/v1/partner/devices/${deviceId}/mark-recovered`)
      .set('X-Api-Key', apiKey);

    const { accessToken, userId } = await registerUser();
    const res = await link(accessToken, deviceId, ingestToken, {
      name: 'My Spark',
    });
    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({
      _id: deviceId,
      user: userId,
      name: 'My Spark',
    });
    expect(res.body.device.linkedAt).toEqual(expect.any(String));
    expect(res.body.device.provisioningTokenHash).toBeUndefined();
    expect(res.body.device.claimInstallIdHash).toBeUndefined();

    expect(
      await EvidenceEnvelope.countDocuments({ user: { $exists: false } }),
    ).toBe(0);
    const episodes = await request(testServer())
      .get('/api/v1/episodes')
      .set('Authorization', auth(accessToken));
    expect(episodes.body.episodes).toHaveLength(1);
    const listed = await request(testServer())
      .get('/api/v1/devices')
      .set('Authorization', auth(accessToken));
    expect(listed.body.devices.map((d: { _id: string }) => d._id)).toEqual([
      deviceId,
    ]);

    expect((await link(accessToken, deviceId, ingestToken)).status).toBe(200);
  });

  it('refuses a second account', async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    const first = await registerUser();
    await link(first.accessToken, deviceId, ingestToken);
    const second = await registerUser({ email: 'second@tambo.app' });
    const res = await link(second.accessToken, deviceId, ingestToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_already_linked');
  });

  it("refuses a device token for a different phone than the path's", async () => {
    const { ingestToken } = await claimedPhone();
    const { accessToken } = await registerUser();
    const res = await link(
      accessToken,
      new Types.ObjectId().toString(),
      ingestToken,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });

  it('refuses while an episode is open: whoever holds the phone now must not adopt it', async () => {
    const { deviceId, ingestToken, apiKey } = await claimedPhone();
    await openByThreshold(ingestToken);
    const { accessToken } = await registerUser();

    const refused = await link(accessToken, deviceId, ingestToken);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('episode_open');

    const resolved = await request(testServer())
      .post(`/api/v1/partner/devices/${deviceId}/mark-recovered`)
      .set('X-Api-Key', apiKey);
    expect(resolved.status).toBe(200);
    expect(resolved.body.episode.resolution).toBe('recovered');
    expect((await link(accessToken, deviceId, ingestToken)).status).toBe(200);
  });

  it("counts against the plan's device allowance", async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    const { accessToken } = await registerUser();
    await request(testServer())
      .post('/api/v1/devices')
      .set('Authorization', auth(accessToken))
      .send(handset([IMEI_B], { name: 'Old phone' }));
    const res = await link(accessToken, deviceId, ingestToken);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_limit');
  });

  it('ends the install’s right to re-claim', async () => {
    const { apiKey } = await partnerWithKey();
    const token = (await provision(apiKey, [handset()])).body.devices[0]
      .provisioningToken;
    const claimed = await claim(token);
    const { accessToken } = await registerUser();
    await link(accessToken, claimed.body.device._id, claimed.body.ingestToken);
    const retry = await claim(token);
    expect(retry.status).toBe(409);
    expect(retry.body.code).toBe('device_already_claimed');
  });
});

describe('a phone with no owner', () => {
  it("alerts the partner's recipients when its threshold opens an episode", async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    await openByThreshold(ingestToken);

    const episode = await TheftEpisode.findOne({ device: deviceId });
    expect(episode!.user).toBeUndefined();
    await until(() =>
      noopMailer.sent.some((mail) => mail.to === 'ops@acme.example'),
    );
    const mail = noopMailer.sent.find((m) => m.to === 'ops@acme.example')!;
    expect(mail.subject).toContain('unlinked Acme Phones device');
    expect(mail.text).toContain(IMEI_A);
    expect(mail.text).toContain(`/partner/devices/${deviceId}/mark-recovered`);

    // deduped like the owner's first alert: a second opener is silent
    const deliveries = await PackDelivery.find({ episode: episode!._id });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.user).toBeUndefined();
  });

  it('opens the episode quietly when the partner has no recipients', async () => {
    const { deviceId, ingestToken } = await claimedPhone({
      alertRecipients: [],
    });
    await openByThreshold(ingestToken);
    expect(await TheftEpisode.exists({ device: deviceId })).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(noopMailer.sent).toHaveLength(0);
  });

  it("is advised under the partner's default plan", async () => {
    const { ingestToken } = await claimedPhone({ defaultPlan: 'pro' });
    const res = await openByThreshold(ingestToken);
    expect(res.body.trailCadenceSeconds).toBe(60);
    expect(res.body.snapshotPolicy.maxBurstsPerEpisode).toBe(20);

    const free = await claimedPhone();
    const freeRes = await openByThreshold(free.ingestToken);
    expect(freeRes.body.trailCadenceSeconds).toBe(300);
  });

  it('cannot register for push until linked', async () => {
    const { ingestToken } = await claimedPhone();
    const res = await request(testServer())
      .post('/api/v1/evidence/push-token')
      .set('X-Device-Token', ingestToken)
      .send({ token: 'fcm-token-for-an-unlinked-phone', platform: 'android' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_not_linked');
  });

  it('is invisible on every owner surface', async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    await openByThreshold(ingestToken);
    const { accessToken } = await registerUser();

    for (const path of [
      `/api/v1/devices/${deviceId}`,
      `/api/v1/devices/${deviceId}/activity`,
      `/api/v1/devices/${deviceId}/commands`,
    ]) {
      const res = await request(testServer())
        .get(path)
        .set('Authorization', auth(accessToken));
      expect(res.status).toBe(404);
    }
    const stolen = await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', auth(accessToken))
      .send({});
    expect(stolen.status).toBe(404);
    const episodes = await request(testServer())
      .get('/api/v1/episodes')
      .set('Authorization', auth(accessToken));
    expect(episodes.body.episodes).toEqual([]);
  });
});

describe('POST /api/v1/partner/devices/:id/mark-recovered', () => {
  it("only reaches the partner's own phones", async () => {
    const { deviceId, ingestToken } = await claimedPhone();
    await openByThreshold(ingestToken);
    const other = await partnerWithKey();
    const res = await request(testServer())
      .post(`/api/v1/partner/devices/${deviceId}/mark-recovered`)
      .set('X-Api-Key', other.apiKey);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });

  it('404s with no open episode', async () => {
    const { deviceId, apiKey } = await claimedPhone();
    const res = await request(testServer())
      .post(`/api/v1/partner/devices/${deviceId}/mark-recovered`)
      .set('X-Api-Key', apiKey);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('episode_not_found');
  });

  it('leaves a linked phone to its owner', async () => {
    const { deviceId, ingestToken, apiKey } = await claimedPhone();
    const { accessToken } = await registerUser();
    await link(accessToken, deviceId, ingestToken);
    await request(testServer())
      .post(`/api/v1/devices/${deviceId}/mark-stolen`)
      .set('Authorization', auth(accessToken))
      .send({});
    const res = await request(testServer())
      .post(`/api/v1/partner/devices/${deviceId}/mark-recovered`)
      .set('X-Api-Key', apiKey);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('device_linked');
  });
});

describe('the Device model', () => {
  it('refuses a device with neither an owner nor a partner', async () => {
    await expect(
      Device.create({
        name: 'Orphan',
        imeis: [IMEI_A],
        make: 'Tecno',
        deviceModel: 'Spark',
      }),
    ).rejects.toThrow(/user/);
  });
});
