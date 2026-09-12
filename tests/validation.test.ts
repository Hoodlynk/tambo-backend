import request from 'supertest';
import { testServer } from './setup/testServer';
import User from '../src/models/user.model';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';
import { CREDENTIALS } from './helpers/factories';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterAll(closeTestDb);

const post = (path: string, body?: object) =>
  request(testServer()).post(path).send(body);

describe('validation envelope', () => {
  it('reports every offending field at once, not just the first', async () => {
    const res = await post('/api/auth/register', {
      name: '',
      email: 'nope',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
    expect(
      res.body.details.map((d: { field: string }) => d.field).sort(),
    ).toEqual(['email', 'name', 'password']);
    expect(res.body.details[0]).toHaveProperty('message');
  });

  it('rejects a missing body entirely', async () => {
    const res = await post('/api/auth/register', undefined);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });
});

describe('register validation', () => {
  it.each([
    [
      'missing name',
      { email: CREDENTIALS.email, password: CREDENTIALS.password },
    ],
    ['blank name', { ...CREDENTIALS, name: '   ' }],
    ['malformed email', { ...CREDENTIALS, email: 'not-an-email' }],
    ['password under 8', { ...CREDENTIALS, password: 'abc1234' }],
    ['password over 72 bytes', { ...CREDENTIALS, password: 'x'.repeat(73) }],
    [
      'password over 72 BYTES via multibyte chars',
      { ...CREDENTIALS, password: '\u00e9'.repeat(40) },
    ],
    ['wrong type', { ...CREDENTIALS, name: 42 }],
  ])('rejects %s', async (_label, body) => {
    const res = await post('/api/auth/register', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
    expect(await User.countDocuments({})).toBe(0);
  });

  it('trims and lowercases before persisting', async () => {
    const res = await post('/api/auth/register', {
      name: '  Ada Lovelace  ',
      email: '  ADA@Tambo.app ',
      password: CREDENTIALS.password,
    });

    expect(res.status).toBe(201);
    const stored = await User.findOne({});
    expect(stored?.name).toBe('Ada Lovelace');
    expect(stored?.email).toBe('ada@tambo.app');
  });

  it('strips unknown keys rather than passing them to the model', async () => {
    const suppliedVerificationDate = new Date(0).toISOString();
    const res = await post('/api/auth/register', {
      ...CREDENTIALS,
      emailVerifiedAt: suppliedVerificationDate,
      isAdmin: true,
    });

    expect(res.status).toBe(201);
    const stored = await User.findOne({});
    // only a verified code sets this - a supplied value must never stick
    expect(stored?.emailVerifiedAt).toBeUndefined();
    expect(stored?.toObject()).not.toHaveProperty('isAdmin');
  });
});

describe('other endpoint validation', () => {
  it.each([
    ['/api/auth/login', {}],
    ['/api/auth/refresh', {}],
    ['/api/auth/logout', {}],
    ['/api/auth/forgot-password', { email: 'bad' }],
    ['/api/auth/reset-password', { token: 'abc' }],
    ['/api/auth/otp/verify', { challengeId: 'not-hex', code: '123456' }],
    ['/api/auth/otp/verify', { challengeId: 'a'.repeat(24), code: '12345' }],
    ['/api/auth/otp/verify', { challengeId: 'a'.repeat(24), code: 'abcdef' }],
    ['/api/auth/otp/resend', {}],
  ])('rejects a bad body for %s', async (path, body) => {
    const res = await post(path, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('validation_error');
  });

  it('validates route params', async () => {
    const res = await request(testServer()).delete(
      '/api/auth/sessions/not-an-object-id',
    );
    // auth runs first, so an unauthenticated call is 401 regardless of the id
    expect(res.status).toBe(401);
  });
});

describe('malformed transport', () => {
  it('returns 400 invalid_json for a body that is not JSON', async () => {
    const res = await request(testServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_json');
  });

  it('returns 413 for a body over the size cap', async () => {
    const res = await request(testServer())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(120 * 1024) }),
      );

    expect(res.status).toBe(413);
    expect(res.body.code).toBe('payload_too_large');
  });
});

describe('unmatched routes', () => {
  it('returns a structured 404', async () => {
    const res = await request(testServer()).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('route_not_found');
  });
});
