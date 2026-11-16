import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';
import { Types } from 'mongoose';
import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import Partner from '../src/models/partner.model';
import PartnerApiKey from '../src/models/partnerApiKey.model';
import PartnerWebhook from '../src/models/partnerWebhook.model';
import WebhookDelivery from '../src/models/webhookDelivery.model';
import { noopMailer } from '../src/services/mailer/noop.mailer';
import { MAX_ATTEMPTS, dispatchDue } from '../src/services/webhook.service';
import {
  isBlockedAddress,
  post,
  signatureHeader,
} from '../src/services/webhook/transport';
import { hashOpaqueToken, sha256Hex } from '../src/utils/tokens';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { registerUser } from './helpers/factories';

// --- A partner's receiving end, on loopback ----------------------------------

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

let received: Received[] = [];
let respondWith = 200;
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
  });
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.statusCode = respondWith;
    res.end();
  });
});
let hookUrl = '';

beforeAll(async () => {
  await connectTestDb();
  await new Promise<void>((resolve) =>
    receiver.listen(0, '127.0.0.1', resolve),
  );
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
}, 120_000);
afterEach(async () => {
  await clearTestDb();
  noopMailer.clear();
  received = [];
  respondWith = 200;
});
afterAll(async () => {
  await new Promise((resolve) => receiver.close(resolve));
  await closeTestDb();
});

const until = async (predicate: () => Promise<boolean> | boolean) => {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition never became true');
};

/** Lets fire-and-forget work that should NOT happen have its chance to. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

/** The parts of an event body the assertions read. */
interface HookEvent {
  type: string;
  data: {
    device: Record<string, unknown>;
    episode: Record<string, unknown>;
    burst: { id: string | null };
  };
}

const events = (type: string) =>
  received
    .map((hit) => JSON.parse(hit.body) as HookEvent)
    .filter((event) => event.type === type);

// --- Fixtures ----------------------------------------------------------------

const IMEI = '356938035643809';
const INSTALL = 'install-0123456789abcdef';

const partnerWithKey = async (): Promise<{
  partnerId: string;
  code: string;
  apiKey: string;
}> => {
  const partner = await Partner.create({
    code: `p${crypto.randomBytes(4).toString('hex')}`,
    name: 'Acme Phones',
    type: 'oem',
    brand: {
      displayName: 'Acme',
      colors: { primary: '#0A7F3F', onPrimary: '#FFFFFF' },
    },
  });
  const apiKey = `tpk_${crypto.randomBytes(32).toString('base64url')}`;
  await PartnerApiKey.create({
    partner: partner._id,
    name: 'Ops',
    prefix: apiKey.slice(0, 12),
    keyHash: hashOpaqueToken(apiKey),
    createdBy: new Types.ObjectId(),
  });
  return { partnerId: partner._id.toString(), code: partner.code, apiKey };
};

const api = (apiKey: string) => ({
  get: (path: string) =>
    request(testServer())
      .get(`/api/v1/partner${path}`)
      .set('X-Api-Key', apiKey),
  post: (path: string, body: object = {}) =>
    request(testServer())
      .post(`/api/v1/partner${path}`)
      .set('X-Api-Key', apiKey)
      .send(body),
  delete: (path: string) =>
    request(testServer())
      .delete(`/api/v1/partner${path}`)
      .set('X-Api-Key', apiKey),
});

const register = async (apiKey: string, body: object = {}) => {
  const res = await api(apiKey).post('/webhooks', { url: hookUrl, ...body });
  expect(res.status).toBe(201);
  return res.body as { webhook: { id: string }; secret: string };
};

const provisionAndClaim = async (apiKey: string) => {
  const provisioned = await api(apiKey).post('/devices', {
    devices: [
      { imeis: [IMEI], serial: 'SN-1', make: 'Tecno', deviceModel: 'Spark 20' },
    ],
  });
  const claimed = await request(testServer())
    .post('/api/v1/devices/claim')
    .send({
      provisioningToken: provisioned.body.devices[0].provisioningToken,
      installId: INSTALL,
    });
  expect(claimed.status).toBe(201);
  return {
    deviceId: claimed.body.device._id as string,
    ingestToken: claimed.body.ingestToken as string,
    provisioningToken: provisioned.body.devices[0].provisioningToken as string,
  };
};

let seq = 0;
const envelope = (type = 'UNLOCK_FAILED', payloadObj: object = {}) => {
  const payload = JSON.stringify(payloadObj);
  seq += 1;
  return {
    id: `hook-${Date.now()}-${seq}`,
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

const openByThreshold = async (ingestToken: string) => {
  const res = await ingest(ingestToken, [envelope(), envelope(), envelope()]);
  expect(res.body.episodeOpened).toBe(true);
  return res.body.episodeId as string;
};

const verify = (hit: Received, secret: string): boolean => {
  const header = String(hit.headers['tambo-signature']);
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  return signatureHeader(secret, hit.body, Number(match[1])) === header;
};

// --- Endpoint management -----------------------------------------------------

describe('partner webhook endpoints', () => {
  it('registers an endpoint and shows the secret once', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook, secret } = await register(apiKey);

    expect(secret).toMatch(/^whsec_/);
    expect(webhook).toMatchObject({
      url: hookUrl,
      events: [
        'episode.opened',
        'episode.resolved',
        'snapshot.received',
        'device.claimed',
      ],
      secretPrefix: secret.slice(0, 12),
    });

    const listed = await api(apiKey).get('/webhooks');
    expect(listed.status).toBe(200);
    expect(listed.body.webhooks).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
  });

  it('needs a partner API key', async () => {
    const res = await request(testServer())
      .post('/api/v1/partner/webhooks')
      .send({ url: hookUrl });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('missing_api_key');
  });

  it('validates the url and event names', async () => {
    const { apiKey } = await partnerWithKey();
    expect(
      (await api(apiKey).post('/webhooks', { url: 'not a url' })).status,
    ).toBe(400);
    expect(
      (
        await api(apiKey).post('/webhooks', {
          url: hookUrl,
          events: ['episode.exploded'],
        })
      ).status,
    ).toBe(400);
  });

  it('caps a partner at five endpoints', async () => {
    const { apiKey } = await partnerWithKey();
    for (let i = 0; i < 5; i += 1) await register(apiKey);
    const sixth = await api(apiKey).post('/webhooks', { url: hookUrl });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('webhook_limit');
  });

  it("never lets one partner touch another's endpoint", async () => {
    const owner = await partnerWithKey();
    const other = await partnerWithKey();
    const { webhook } = await register(owner.apiKey);

    for (const res of [
      await api(other.apiKey).delete(`/webhooks/${webhook.id}`),
      await api(other.apiKey).post(`/webhooks/${webhook.id}/rotate-secret`),
      await api(other.apiKey).post(`/webhooks/${webhook.id}/ping`),
      await api(other.apiKey).get(`/webhooks/${webhook.id}/deliveries`),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('webhook_not_found');
    }
    expect(await PartnerWebhook.countDocuments()).toBe(1);
  });

  it('rotates the secret; the next send is signed with the new one only', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook, secret: old } = await register(apiKey);

    const rotated = await api(apiKey).post(
      `/webhooks/${webhook.id}/rotate-secret`,
    );
    expect(rotated.status).toBe(200);
    expect(rotated.body.secret).not.toBe(old);

    await api(apiKey).post(`/webhooks/${webhook.id}/ping`);
    await until(() => received.length === 1);
    expect(verify(received[0]!, rotated.body.secret)).toBe(true);
    expect(verify(received[0]!, old)).toBe(false);
  });

  it('removes an endpoint with its queue and log', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook } = await register(apiKey);
    await api(apiKey).post(`/webhooks/${webhook.id}/ping`);
    await until(() => received.length === 1);

    const res = await api(apiKey).delete(`/webhooks/${webhook.id}`);
    expect(res.status).toBe(204);
    expect(await PartnerWebhook.countDocuments()).toBe(0);
    expect(await WebhookDelivery.countDocuments()).toBe(0);
  });
});

// --- Signing and the delivery log --------------------------------------------

describe('ping and signatures', () => {
  it('delivers a signed ping and logs it as delivered', async () => {
    const { apiKey, code } = await partnerWithKey();
    const { webhook, secret } = await register(apiKey, {
      events: ['device.claimed'],
    });

    const res = await api(apiKey).post(`/webhooks/${webhook.id}/ping`);
    expect(res.status).toBe(202);
    expect(res.body.delivery).toMatchObject({ type: 'ping' });

    await until(() => received.length === 1);
    const hit = received[0]!;
    expect(verify(hit, secret)).toBe(true);
    expect(hit.headers['tambo-event-type']).toBe('ping');
    expect(hit.headers['tambo-event-id']).toBe(res.body.delivery.eventId);
    expect(JSON.parse(hit.body)).toMatchObject({
      id: res.body.delivery.eventId,
      type: 'ping',
      partner: code,
      data: { webhookId: webhook.id },
    });

    await until(async () => {
      const log = await api(apiKey).get(`/webhooks/${webhook.id}/deliveries`);
      return log.body.deliveries[0]?.status === 'delivered';
    });
    const log = await api(apiKey).get(`/webhooks/${webhook.id}/deliveries`);
    expect(log.body.deliveries[0]).toMatchObject({
      attempts: 1,
      lastStatusCode: 200,
      lastError: null,
      nextAttemptAt: null,
    });
  });

  it('a tampered body fails verification', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook, secret } = await register(apiKey);
    await api(apiKey).post(`/webhooks/${webhook.id}/ping`);
    await until(() => received.length === 1);
    const hit = received[0]!;
    expect(
      verify({ ...hit, body: hit.body.replace('ping', 'pong') }, secret),
    ).toBe(false);
  });
});

// --- Fleet events -------------------------------------------------------------

describe('fleet events', () => {
  it('device.claimed fires on the first claim, not on a retry', async () => {
    const { apiKey } = await partnerWithKey();
    const { secret } = await register(apiKey);
    const { deviceId, provisioningToken } = await provisionAndClaim(apiKey);

    await until(() => events('device.claimed').length === 1);
    expect(verify(received[0]!, secret)).toBe(true);
    expect(events('device.claimed')[0]!.data.device).toMatchObject({
      id: deviceId,
      imeis: [IMEI],
      serial: 'SN-1',
      provisioned: true,
      linked: false,
      status: 'active',
    });

    const retry = await request(testServer())
      .post('/api/v1/devices/claim')
      .send({ provisioningToken, installId: INSTALL });
    expect(retry.status).toBe(200);
    await settle();
    expect(events('device.claimed')).toHaveLength(1);
  });

  it('episode.opened and episode.resolved follow the episode', async () => {
    const { apiKey } = await partnerWithKey();
    await register(apiKey);
    const { deviceId, ingestToken } = await provisionAndClaim(apiKey);
    const episodeId = await openByThreshold(ingestToken);

    await until(() => events('episode.opened').length === 1);
    expect(events('episode.opened')[0]!.data).toMatchObject({
      device: { id: deviceId, status: 'stolen' },
      episode: { id: episodeId, openedBy: 'device' },
    });

    const resolved = await api(apiKey).post(
      `/devices/${deviceId}/mark-recovered`,
    );
    expect(resolved.status).toBe(200);
    await until(() => events('episode.resolved').length === 1);
    expect(events('episode.resolved')[0]!.data).toMatchObject({
      device: { id: deviceId, status: 'active' },
      episode: { id: episodeId, resolution: 'recovered' },
    });
  });

  it("fires for a person's phone enrolled under the partner code, without IMEIs", async () => {
    const { apiKey, code } = await partnerWithKey();
    await register(apiKey);
    const user = await registerUser();
    const enrolled = await request(testServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        name: 'My Tecno',
        imeis: [IMEI],
        make: 'Tecno',
        deviceModel: 'Spark 20',
        partnerCode: code,
      });
    expect(enrolled.status).toBe(201);

    const stolen = await request(testServer())
      .post(`/api/v1/devices/${enrolled.body.device._id}/mark-stolen`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({});
    expect(stolen.status).toBe(201);

    await until(() => events('episode.opened').length === 1);
    const { data } = events('episode.opened')[0]!;
    expect(data.device).toMatchObject({
      imeis: null,
      provisioned: false,
      linked: true,
    });
    expect(data.episode.openedBy).toBe('owner');
    // no owner identity, no device name, no location
    expect(JSON.stringify(data)).not.toMatch(/My Tecno|@|lat/);
  });

  it('snapshot.received fires once per burst, across batches', async () => {
    const { apiKey } = await partnerWithKey();
    await register(apiKey);
    const { ingestToken } = await provisionAndClaim(apiKey);
    const episodeId = await openByThreshold(ingestToken);

    const frame = (burstId: string, n: number) =>
      envelope('PHOTO', {
        burstId,
        seq: n,
        count: 2,
        camera: 'front',
        trigger: 'failed_unlock',
      });
    await ingest(ingestToken, [frame('burst-aaaa', 0), frame('burst-bbbb', 0)]);
    await ingest(ingestToken, [frame('burst-aaaa', 1), frame('burst-bbbb', 1)]);

    await until(() => events('snapshot.received').length === 2);
    await settle();
    const notices = events('snapshot.received');
    expect(notices).toHaveLength(2);
    expect(notices.map((event) => event.data.burst.id).sort()).toEqual([
      'burst-aaaa',
      'burst-bbbb',
    ]);
    expect(notices[0]!.data).toMatchObject({
      episodeId,
      burst: { camera: 'front', trigger: 'failed_unlock' },
    });
  });

  it('sends only the events an endpoint subscribed to', async () => {
    const { apiKey } = await partnerWithKey();
    await register(apiKey, { events: ['episode.resolved'] });
    const { ingestToken } = await provisionAndClaim(apiKey);
    await openByThreshold(ingestToken);
    await settle();
    expect(received).toHaveLength(0);
  });

  it('fans one event out to every subscribed endpoint with one event id', async () => {
    const { apiKey } = await partnerWithKey();
    await register(apiKey, { events: ['device.claimed'] });
    await register(apiKey, { events: ['device.claimed'] });
    await provisionAndClaim(apiKey);

    await until(() => received.length === 2);
    expect(received[0]!.headers['tambo-event-id']).toBe(
      received[1]!.headers['tambo-event-id'],
    );
  });
});

// --- Retries -------------------------------------------------------------------

describe('retries', () => {
  it('backs off after a failure and delivers the same bytes on the sweep', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook } = await register(apiKey);
    respondWith = 503;
    await api(apiKey).post(`/webhooks/${webhook.id}/ping`);

    await until(async () => {
      const row = await WebhookDelivery.findOne();
      return row?.attempts === 1 && row.lockedUntil === undefined;
    });
    const failed = await WebhookDelivery.findOne();
    expect(failed).toMatchObject({
      status: 'pending',
      lastStatusCode: 503,
      lastError: 'http_503',
    });
    expect(failed!.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // not due yet: the sweep leaves it alone
    expect(await dispatchDue()).toBe(0);

    respondWith = 200;
    await WebhookDelivery.updateOne(
      { _id: failed!._id },
      { $set: { nextAttemptAt: new Date(Date.now() - 1000) } },
    );
    expect(await dispatchDue()).toBe(1);

    const delivered = await WebhookDelivery.findOne();
    expect(delivered).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(received).toHaveLength(2);
    expect(received[1]!.body).toBe(received[0]!.body);
  });

  it('gives up after the last attempt', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook } = await register(apiKey);
    respondWith = 500;
    await api(apiKey).post(`/webhooks/${webhook.id}/ping`);
    await until(async () => (await WebhookDelivery.findOne())?.attempts === 1);
    await until(
      async () => (await WebhookDelivery.findOne())?.lockedUntil === undefined,
    );

    await WebhookDelivery.updateOne(
      {},
      {
        $set: {
          attempts: MAX_ATTEMPTS - 1,
          nextAttemptAt: new Date(Date.now() - 1000),
        },
      },
    );
    await dispatchDue();
    const row = await WebhookDelivery.findOne();
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS });
    expect(row!.nextAttemptAt).toBeUndefined();
  });

  it('never sends one attempt twice when the sweep races the first send', async () => {
    const { apiKey } = await partnerWithKey();
    const { webhook } = await register(apiKey);
    await Promise.all([
      api(apiKey).post(`/webhooks/${webhook.id}/ping`),
      dispatchDue(),
      dispatchDue(),
    ]);
    await until(
      async () => (await WebhookDelivery.findOne())?.status === 'delivered',
    );
    await dispatchDue();
    await settle();
    expect(received).toHaveLength(1);
  });
});

// --- The SSRF guard -------------------------------------------------------------

describe('webhook transport address guard', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '41.90.1.1', '2001:4860:4860::8888'])(
    'allows %s',
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  describe('with local targets off, as in production', () => {
    beforeEach(() => {
      config.webhooks.allowLocalTargets = false;
    });
    afterEach(() => {
      config.webhooks.allowLocalTargets = true;
    });

    const send = (url: string) =>
      post({ url, secret: 's', eventId: 'e', type: 'ping', body: '{}' });

    it('refuses plain http', async () => {
      expect(await send(hookUrl)).toEqual({
        ok: false,
        error: 'https_required',
      });
    });

    it('refuses a private IP literal', async () => {
      expect(await send('https://169.254.169.254/latest')).toEqual({
        ok: false,
        error: 'address_blocked',
      });
      expect(await send('https://[::1]/hook')).toEqual({
        ok: false,
        error: 'address_blocked',
      });
    });

    it('refuses a hostname that resolves to loopback', async () => {
      expect(await send('https://localhost/hook')).toEqual({
        ok: false,
        error: 'address_blocked',
      });
    });
  });
});

// --- The partner device read (deferred from B4) ---------------------------------

describe('GET /api/v1/partner/devices/:id', () => {
  it("shows claim, link and episode state for the partner's own phone", async () => {
    const { apiKey } = await partnerWithKey();
    const { deviceId, ingestToken } = await provisionAndClaim(apiKey);

    const before = await api(apiKey).get(`/devices/${deviceId}`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      device: {
        id: deviceId,
        imeis: [IMEI],
        provisioned: true,
        linked: false,
        status: 'active',
      },
      openEpisode: null,
    });
    expect(before.body.device.claimedAt).toEqual(expect.any(String));

    const episodeId = await openByThreshold(ingestToken);
    const during = await api(apiKey).get(`/devices/${deviceId}`);
    expect(during.body.device.status).toBe('stolen');
    expect(during.body.openEpisode).toMatchObject({
      id: episodeId,
      openedBy: 'device',
    });
  });

  it("is 404 for another partner's phone", async () => {
    const owner = await partnerWithKey();
    const other = await partnerWithKey();
    const { deviceId } = await provisionAndClaim(owner.apiKey);
    const res = await api(other.apiKey).get(`/devices/${deviceId}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('device_not_found');
  });
});
