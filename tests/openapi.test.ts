import SwaggerParser from '@apidevtools/swagger-parser';
import request from 'supertest';
import { testServer } from './setup/testServer';
import { buildOpenApiDocument } from '../src/openapi/generate';
import { endpoints } from '../src/openapi/registry';
import { clearTestDb, closeTestDb, connectTestDb } from './helpers/db';

beforeAll(connectTestDb, 120_000);
afterEach(clearTestDb);
afterAll(closeTestDb);

describe('GET /api/openapi.json', () => {
  it('serves the generated document', async () => {
    const res = await request(testServer()).get('/api/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(Object.keys(res.body.paths).length).toBeGreaterThanOrEqual(35);
    expect(res.body.components.securitySchemes.bearerAuth).toBeDefined();
  });
});

describe('the document', () => {
  it('is a valid OpenAPI document (swagger-parser)', async () => {
    // validate() mutates its input while dereferencing; hand it a fresh copy
    await expect(
      SwaggerParser.validate(
        buildOpenApiDocument() as unknown as Parameters<
          typeof SwaggerParser.validate
        >[0],
      ),
    ).resolves.toBeDefined();
  });

  it('gives every endpoint at least one success response and tags every error with the envelope', () => {
    for (const endpoint of endpoints) {
      const success = endpoint.responses.filter(
        (response) => response.status >= 200 && response.status < 300,
      );
      expect(`${endpoint.method} ${endpoint.path}: ${success.length}`).not.toBe(
        `${endpoint.method} ${endpoint.path}: 0`,
      );
      for (const error of endpoint.errors ?? []) {
        expect(error.status).toBeGreaterThanOrEqual(400);
        expect(error.code).toMatch(/^[a-z][a-z_]+$/);
      }
    }
  });
});

describe('generated document behavior', () => {
  it('injects the implicit 400 validation_error on param-only endpoints', () => {
    const doc = buildOpenApiDocument() as {
      paths: Record<
        string,
        Record<string, { responses: Record<string, { description: string }> }>
      >;
    };
    // GET /devices/{id} declares no 400 in the registry; the generator must
    // add it (strict 24-hex param -> validation_error is reachable)
    const op = doc.paths['/api/v1/devices/{id}']!.get!;
    expect(op.responses['400']).toBeDefined();
    expect(op.responses['400']!.description).toContain('validation_error');
  });
});

describe('spec ↔ server drift', () => {
  /**
   * Every registered path must resolve to a REAL Express route: probing it
   * unauthenticated must produce anything except the router's 404
   * (route_not_found). Auth/validation failures are proof enough that the
   * route exists; they also guarantee the probe has no side effects.
   */
  it('every documented path is actually served', async () => {
    const misses: string[] = [];

    for (const endpoint of endpoints) {
      const concrete = endpoint.path.replace(
        /\{[^}]+\}/g,
        'aaaaaaaaaaaaaaaaaaaaaaaa', // a plausible 24-hex id for any {param}
      );
      const res = await request(testServer())[endpoint.method](concrete);
      if (res.status === 404 && res.body?.code === 'route_not_found') {
        misses.push(`${endpoint.method.toUpperCase()} ${endpoint.path}`);
      }
    }

    expect(misses).toEqual([]);
  });
});
