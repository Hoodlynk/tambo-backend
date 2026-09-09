import request from 'supertest';
import { testServer } from './setup/testServer';
import config from '../src/config/config';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { acceptLegalDocs, registerUser } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterAll(closeTestDb);

const getDocuments = () => request(testServer()).get('/api/v1/legal');

const getStatus = (accessToken: string) =>
  request(testServer())
    .get('/api/v1/legal/status')
    .set('Authorization', `Bearer ${accessToken}`);

const accept = (accessToken: string, body: object) =>
  request(testServer())
    .post('/api/v1/legal/accept')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body);

const CURRENT_TERMS = config.legal.terms.version;

describe('GET /api/v1/legal', () => {
  it('serves both documents publicly with version and url', async () => {
    const res = await getDocuments();

    expect(res.status).toBe(200);
    expect(res.body.documents).toHaveLength(2);
    const docs = Object.fromEntries(
      res.body.documents.map((d: { doc: string }) => [d.doc, d]),
    );
    expect(docs.terms).toMatchObject({
      version: CURRENT_TERMS,
      url: config.legal.terms.url,
    });
    expect(docs.privacy).toMatchObject({
      version: config.legal.privacy.version,
      url: config.legal.privacy.url,
    });
  });
});

describe('GET /api/v1/legal/status', () => {
  it('requires authentication', async () => {
    const res = await request(testServer()).get('/api/v1/legal/status');
    expect(res.status).toBe(401);
  });

  it('reports both documents as not accepted for a fresh account', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });
    const res = await getStatus(accessToken);

    expect(res.status).toBe(200);
    for (const doc of res.body.documents) {
      expect(doc).toMatchObject({
        upToDate: false,
        acceptedVersion: null,
        acceptedAt: null,
      });
    }
  });
});

describe('POST /api/v1/legal/accept', () => {
  it('records a scroll-gated acceptance and flips status to upToDate', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });

    const res = await accept(accessToken, {
      doc: 'terms',
      version: CURRENT_TERMS,
      scrolledToEnd: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.document).toMatchObject({
      doc: 'terms',
      upToDate: true,
      acceptedVersion: CURRENT_TERMS,
    });
    expect(res.body.document.acceptedAt).toBeTruthy();

    // privacy remains outstanding - each document is accepted separately
    const status = await getStatus(accessToken);
    const byDoc = Object.fromEntries(
      status.body.documents.map((d: { doc: string }) => [d.doc, d]),
    );
    expect(byDoc.terms.upToDate).toBe(true);
    expect(byDoc.privacy.upToDate).toBe(false);
  });

  it('rejects an acceptance that was not scrolled to the end', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });

    const res = await accept(accessToken, {
      doc: 'terms',
      version: CURRENT_TERMS,
      scrolledToEnd: false,
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });

  it('rejects a stale version so the app re-presents the document', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });

    const res = await accept(accessToken, {
      doc: 'privacy',
      version: 'ancient-0.1',
      scrolledToEnd: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_legal_version');
  });

  it('is idempotent for the same (doc, version)', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });
    const body = {
      doc: 'terms',
      version: CURRENT_TERMS,
      scrolledToEnd: true,
    };

    const first = await accept(accessToken, body);
    const second = await accept(accessToken, body);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.document.upToDate).toBe(true);
  });

  it('requires authentication - acceptance must be attributable', async () => {
    const res = await request(testServer())
      .post('/api/v1/legal/accept')
      .send({ doc: 'terms', version: CURRENT_TERMS, scrolledToEnd: true });

    expect(res.status).toBe(401);
  });
});

describe('legal gate on device enrolment', () => {
  const enrolDevice = (accessToken: string) =>
    request(testServer())
      .post('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'My Tecno',
        imeis: ['356938035643809'],
        make: 'Tecno',
        deviceModel: 'Spark 20',
      });

  it('refuses enrolment until both documents are accepted', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });

    const blocked = await enrolDevice(accessToken);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('legal_acceptance_required');

    // accepting only ONE document is not enough
    await accept(accessToken, {
      doc: 'terms',
      version: CURRENT_TERMS,
      scrolledToEnd: true,
    });
    const stillBlocked = await enrolDevice(accessToken);
    expect(stillBlocked.status).toBe(403);

    await accept(accessToken, {
      doc: 'privacy',
      version: config.legal.privacy.version,
      scrolledToEnd: true,
    });
    const allowed = await enrolDevice(accessToken);
    expect(allowed.status).toBe(201);
  });

  it('does not gate managing an already-enrolled device', async () => {
    // accepted at enrolment time...
    const { accessToken } = await registerUser();
    const enrolled = await enrolDevice(accessToken);
    expect(enrolled.status).toBe(201);

    // ...then simulate a document version bump by deleting the acceptance
    // rows: existing-device management must keep working regardless
    const { default: LegalAcceptance } =
      await import('../src/models/legalAcceptance.model');
    await LegalAcceptance.deleteMany({});

    const list = await request(testServer())
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);

    const markStolen = await request(testServer())
      .post(`/api/v1/devices/${enrolled.body.device._id}/mark-stolen`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(markStolen.status).toBe(201);
  });

  it('acceptLegalDocs helper satisfies the gate (factory contract)', async () => {
    const { accessToken } = await registerUser({}, { acceptLegal: false });
    await acceptLegalDocs(accessToken);
    expect((await enrolDevice(accessToken)).status).toBe(201);
  });
});
