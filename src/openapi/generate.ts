import { z } from 'zod';
import type { ZodObject, ZodType } from 'zod';
import { endpoints } from './registry';
import type { Endpoint, EndpointError } from './registry';
import { errorResponse } from './responses';

/**
 * Assembles the OpenAPI 3.1 document from the endpoint registry. Zod v4's
 * native JSON-Schema export does the shape conversion; requests use io:input
 * (what the client SENDS, before trim/lowercase normalization), responses use
 * io:output.
 *
 * Generated on demand and cached: the schemas are static for a process
 * lifetime, and the mobile/PWA build pipelines fetch this from
 * GET /api/openapi.json or `npm run openapi`.
 */

const toSchema = (
  schema: ZodType,
  io: 'input' | 'output',
): Record<string, unknown> => {
  const json = z.toJSONSchema(schema, { io, target: 'openapi-3.0' }) as Record<
    string,
    unknown
  >;
  // the $schema keyword is noise inside an OpenAPI document
  delete json.$schema;
  return json;
};

/** Path/query parameter objects from a zod object schema's fields. */
const toParameters = (
  schema: ZodType,
  location: 'path' | 'query',
): Record<string, unknown>[] => {
  const json = toSchema(schema, 'input');
  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const required = new Set((json.required as string[]) ?? []);
  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: propSchema,
  }));
};

const errorsByStatus = (
  errors: EndpointError[],
): Map<number, EndpointError[]> => {
  const grouped = new Map<number, EndpointError[]>();
  for (const error of errors) {
    grouped.set(error.status, [...(grouped.get(error.status) ?? []), error]);
  }
  return grouped;
};

/**
 * Failures every endpoint inherits from middleware rather than declaring:
 * any request with a validated body/params/query can 400 validation_error.
 * Injected here so the registry cannot under-document them.
 */
const implicitErrors = (endpoint: Endpoint): EndpointError[] => {
  const declared = new Set(
    (endpoint.errors ?? []).map((error) => `${error.status}:${error.code}`),
  );
  const implied: EndpointError[] = [];
  if (
    (endpoint.request?.body ||
      endpoint.request?.params ||
      endpoint.request?.query) &&
    !declared.has('400:validation_error')
  ) {
    implied.push({
      status: 400,
      code: 'validation_error',
      description: 'A field failed validation; see details[].',
    });
  }
  return implied;
};

const operationFor = (endpoint: Endpoint): Record<string, unknown> => {
  const parameters: Record<string, unknown>[] = [];
  if (endpoint.request?.params) {
    parameters.push(...toParameters(endpoint.request.params, 'path'));
  }
  if (endpoint.request?.query) {
    parameters.push(...toParameters(endpoint.request.query, 'query'));
  }
  for (const header of endpoint.request?.headers ?? []) {
    parameters.push({
      name: header.name,
      in: 'header',
      required: header.required,
      description: header.description,
      schema: { type: 'string' },
    });
  }

  const responses: Record<string, unknown> = {};
  for (const response of endpoint.responses) {
    responses[String(response.status)] = {
      description: response.description,
      ...(response.schema || response.contentType
        ? {
            content: {
              [response.contentType ?? 'application/json']: response.schema
                ? { schema: toSchema(response.schema, 'output') }
                : { schema: { type: 'string', format: 'binary' } },
            },
          }
        : {}),
    };
  }
  for (const [status, errors] of errorsByStatus([
    ...(endpoint.errors ?? []),
    ...implicitErrors(endpoint),
  ])) {
    responses[String(status)] = {
      description: errors
        .map(
          (e) => `\`${e.code}\`${e.description ? ` — ${e.description}` : ''}`,
        )
        .join(' · '),
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    };
  }

  return {
    tags: [endpoint.tag],
    summary: endpoint.summary,
    ...(endpoint.description ? { description: endpoint.description } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(endpoint.request?.body || endpoint.request?.bodyContentType
      ? {
          requestBody: {
            required: true,
            ...(endpoint.request.bodyDescription
              ? { description: endpoint.request.bodyDescription }
              : {}),
            content: {
              [endpoint.request.bodyContentType ?? 'application/json']: endpoint
                .request.body
                ? { schema: toSchema(endpoint.request.body, 'input') }
                : { schema: { type: 'string', format: 'binary' } },
            },
          },
        }
      : {}),
    responses,
    ...(endpoint.auth === 'bearer'
      ? { security: [{ bearerAuth: [] }] }
      : endpoint.auth === 'device'
        ? { security: [{ deviceToken: [] }] }
        : endpoint.auth === 'partnerKey'
          ? { security: [{ partnerApiKey: [] }] }
          : { security: [] }),
  };
};

export const buildOpenApiDocument = (): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    paths[endpoint.path] = {
      ...(paths[endpoint.path] ?? {}),
      [endpoint.method]: operationFor(endpoint),
    };
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'Tambo API',
      version: '1.0.0',
      description:
        'Anti-theft backend: auth (email OTP), devices, evidence ingest, ' +
        'theft episodes, location trail, buddies, legal acceptance, and the ' +
        'signed evidence pack.\n\n' +
        '**Error contract**: every non-2xx response is `{ code, message }` ' +
        '(schema `Error`). Branch on `code`, never on `message` - messages ' +
        'are wording and will change; codes are contract.\n\n' +
        '**Legacy alias**: every `/api/v1/auth/*` path is also served at ' +
        '`/api/auth/*` for pre-OpenAPI mobile builds; new clients use the ' +
        'versioned paths.',
    },
    servers: [{ url: 'https://api.tambo-app.com' }],
    tags: [
      { name: 'Health' },
      { name: 'Auth' },
      {
        name: 'Auth (web)',
        description:
          'The PWA session surface: refresh token in an httpOnly cookie ' +
          '(path /api/auth/web), X-Tambo-Csrf header required, fetch with ' +
          'credentials: "include". Access token stays in memory.',
      },
      { name: 'Devices' },
      { name: 'Episodes' },
      {
        name: 'Evidence',
        description: 'Device-token auth (X-Device-Token), not user auth.',
      },
      { name: 'Buddies' },
      { name: 'Push' },
      { name: 'Plan' },
      { name: 'Familiar locations' },
      { name: 'Legal' },
      {
        name: 'Client',
        description:
          'Every request from a current client carries X-Client-Platform ' +
          '(android | ios | web) and X-Client-Version (X.Y.Z). Both are ' +
          'advisory: recorded on sessions, never required.',
      },
      {
        name: 'Partners',
        description:
          'White-label partners: the admin catalogue, and partner systems ' +
          'authenticating with X-Api-Key.',
      },
      {
        name: 'Webhooks',
        description:
          'Partner endpoints hearing about their fleet. Each POST carries ' +
          'Tambo-Event-Id, Tambo-Event-Type and Tambo-Signature: ' +
          't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed ' +
          'with the endpoint secret>. Any 2xx acknowledges; anything else ' +
          'is retried (8 attempts over ~45 h). Delivery is at-least-once: ' +
          'dedup on the event id. Redirects are not followed.',
      },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'Access token from login/otp-verify/refresh; short-lived ' +
            '(default 15m; deployment-tunable via JWT_ACCESS_TTL).',
        },
        deviceToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Device-Token',
          description: 'The ingest token issued at device registration.',
        },
        partnerApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: 'A partner API key issued by a Tambo admin.',
        },
      },
      schemas: {
        Error: toSchema(errorResponse as unknown as ZodObject, 'output'),
      },
    },
  };
};

let cached: Record<string, unknown> | null = null;

export const openApiDocument = (): Record<string, unknown> =>
  (cached ??= buildOpenApiDocument());
