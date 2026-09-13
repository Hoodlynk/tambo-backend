import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import config from './config/config';
import authRoutes from './routes/auth.routes';
import authWebRoutes from './routes/auth.web.routes';
import healthRoutes from './routes/health.routes';
import openapiRoutes from './routes/openapi.routes';
import buddyRoutes from './routes/v1/buddy.routes';
import buddyInviteRoutes from './routes/v1/buddyInvite.routes';
import deviceRoutes from './routes/v1/device.routes';
import evidenceRoutes from './routes/v1/evidence.routes';
import episodeRoutes from './routes/v1/episode.routes';
import familiarLocationRoutes from './routes/v1/familiarLocation.routes';
import legalRoutes from './routes/v1/legal.routes';
import planRoutes from './routes/v1/plan.routes';
import pushTokenRoutes from './routes/v1/pushToken.routes';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler';
import { requestId, requestLog } from './middlewares/requestId';

const app = express();

/**
 * Must match the real deployment topology. Express uses this to decide whether
 * to believe X-Forwarded-For, and `req.ip` feeds the rate limiter - trusting a
 * proxy that is not there lets any client forge its own IP and bypass limits.
 */
app.set('trust proxy', config.trustProxy);

app.disable('x-powered-by');
app.use(helmet());

// ids first so even a helmet/CORS-level rejection is correlatable
app.use(requestId);
app.use(requestLog);

// Test runs only: close every connection after its response. supertest spins
// up an ephemeral server per request, and socket reuse across those under
// parallel-suite load yields transport corruption ("Parse Error: Expected
// HTTP/", empty-body 4xx no handler wrote). Production keeps keep-alive.
if (config.nodeEnv === 'test') {
  app.use((_req, res, next) => {
    res.set('Connection', 'close');
    next();
  });
}

/**
 * Native mobile clients send no Origin header and are unaffected by CORS. This
 * only matters if a browser-based client (web dashboard, Expo web) is added, in
 * which case list its origins in CORS_ALLOWED_ORIGINS. Empty = deny all
 * browser origins, which is the safe default for a mobile-only API.
 */
app.use(
  cors({
    origin:
      config.cors.allowedOrigins.length > 0
        ? config.cors.allowedOrigins
        : false,
    // the web auth surface authenticates with an httpOnly cookie, which
    // browsers only send cross-origin under credentials mode; the explicit
    // origin allowlist above (never *) is what makes this safe to enable
    credentials: config.cors.allowedOrigins.length > 0,
  }),
);

// Bodies are small JSON payloads; the cap blunts trivial memory-pressure
// attacks. Evidence routes are exempt: they parse their own bodies (bigger
// envelope batches, raw photo bytes) with their own caps.
const defaultJsonParser = express.json({ limit: '100kb' });
app.use((req, res, next) => {
  if (req.path.startsWith('/api/v1/evidence')) {
    next();
    return;
  }
  defaultJsonParser(req, res, next);
});

// --- Routes ----------------------------------------------------------------
app.use('/api/health', healthRoutes);
app.use('/api/openapi.json', openapiRoutes);
// the browser (PWA) surface must mount BEFORE /api/auth: Express would
// otherwise route /api/auth/web/* into the mobile router's 404
app.use('/api/auth/web', authWebRoutes);
app.use('/api/auth', authRoutes);
// canonical versioned mount; /api/auth stays as a legacy alias for the
// pre-OpenAPI mobile builds (same router, so behaviour cannot drift)
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/devices', deviceRoutes);
app.use('/api/v1/evidence', evidenceRoutes);
app.use('/api/v1/episodes', episodeRoutes);
app.use('/api/v1/buddies', buddyRoutes);
app.use('/api/v1/familiar-locations', familiarLocationRoutes);
app.use('/api/v1/buddy-invites', buddyInviteRoutes);
app.use('/api/v1/legal', legalRoutes);
app.use('/api/v1/push-tokens', pushTokenRoutes);
app.use('/api/v1/plan', planRoutes);

// --- Tail: unmatched routes, then the global error handler -----------------
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
