import http from 'http';

/**
 * Node >= 19 turns keep-alive ON for the global HTTP agent. supertest spins up
 * an ephemeral server per request, and under parallel-suite load the socket
 * reuse produces transport-level flakes: "Parse Error: Expected HTTP/",
 * empty-body 400/404s that no app handler ever wrote. One connection per
 * request makes the suite deterministic.
 */
http.globalAgent = new http.Agent({ keepAlive: false });

/**
 * Runs before any module (including config.ts) is imported, so these win over
 * whatever is in .env - dotenv never overrides an already-set variable.
 *
 * Rate limiting is off by default so ordinary tests are not throttled; the
 * rate-limit suite re-enables it explicitly.
 */
process.env.NODE_ENV = 'test';
process.env.MAIL_DRIVER = 'noop';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.JWT_ACCESS_SECRET = 'test-secret-not-used-anywhere-real';
process.env.BCRYPT_ROUNDS = '4'; // keep the suite fast; production uses 12
// the webhook suite delivers to a receiver on 127.0.0.1
process.env.WEBHOOK_ALLOW_LOCAL_TARGETS = 'true';
