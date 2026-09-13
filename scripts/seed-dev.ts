import mongoose from 'mongoose';
import config from '../src/config/config';
import Buddy from '../src/models/buddy.model';
import Device from '../src/models/device.model';
import EvidenceEnvelope from '../src/models/evidenceEnvelope.model';
import LegalAcceptance from '../src/models/legalAcceptance.model';
import PackDelivery from '../src/models/packDelivery.model';
import PushToken from '../src/models/pushToken.model';
import RefreshToken from '../src/models/refreshToken.model';
import TheftEpisode from '../src/models/theftEpisode.model';
import User from '../src/models/user.model';
import { hashPassword } from '../src/services/credentials/password.credential';
import * as deviceService from '../src/services/device.service';
import * as episodeService from '../src/services/episode.service';
import * as evidenceService from '../src/services/evidence.service';
import * as legalService from '../src/services/legal.service';
import * as sessionService from '../src/services/session.service';
import { sha256Hex } from '../src/utils/tokens';

/**
 * Seeds a local database so a client developer has something real to build
 * against in one command: a verified pro-plan user (legal docs accepted), an
 * enrolled device with its ingest token, an OPEN theft episode, and a spread
 * of evidence including located failed unlocks and a moving trail.
 *
 * Idempotent-ish: re-running removes and recreates the seed user by email.
 * NEVER run against production (refuses outside development).
 */

export const SEED_EMAIL = 'dev@tambo.local';
export const SEED_PASSWORD = 'dev-password-1';

export interface SeedResult {
  userId: string;
  deviceId: string;
  ingestToken: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Removes a previous run's ENTIRE footprint, not just the user - deleting
 * only the user would leave an orphaned device with a still-live ingest
 * token, an open episode owned by nobody, and envelope ids that collide with
 * the next run's uploads.
 */
const removePreviousSeed = async (): Promise<void> => {
  const previous = await User.findOne({ email: SEED_EMAIL });
  if (!previous) return;
  const userId = previous._id;
  const devices = await Device.find({ user: userId }).select('_id');
  const deviceIds = devices.map((device) => device._id);
  await Promise.all([
    EvidenceEnvelope.deleteMany({ device: { $in: deviceIds } }),
    TheftEpisode.deleteMany({ user: userId }),
    PackDelivery.deleteMany({ user: userId }),
    Device.deleteMany({ user: userId }),
    Buddy.deleteMany({ owner: userId }),
    LegalAcceptance.deleteMany({ user: userId }),
    RefreshToken.deleteMany({ user: userId }),
    PushToken.deleteMany({ user: userId }),
  ]);
  await User.deleteOne({ _id: userId });
};

/** The seeding itself, against whatever database mongoose is connected to. */
export const seed = async (): Promise<SeedResult> => {
  await removePreviousSeed();
  const user = await User.create({
    name: 'Dev Owner',
    email: SEED_EMAIL,
    passwordHash: await hashPassword(SEED_PASSWORD),
    emailVerifiedAt: new Date(),
    plan: 'pro',
  });
  const userId = user._id.toString();

  for (const doc of ['terms', 'privacy'] as const) {
    await legalService.accept(
      userId,
      { doc, version: config.legal[doc].version, scrolledToEnd: true },
      { userAgent: 'seed-script' },
    );
  }

  const { device, ingestToken } = await deviceService.register(userId, {
    name: 'Dev Tecno',
    imeis: ['356938035643809'],
    make: 'Tecno',
    deviceModel: 'Spark 20',
  });

  await episodeService.markStolen(userId, device._id.toString(), 'seeded');

  // located failed unlocks + a moving trail (Nairobi CBD heading east)
  const points = [
    { lat: -1.2921, lng: 36.8219, accuracyM: 10 },
    { lat: -1.2945, lng: 36.825, accuracyM: 12 },
    { lat: -1.3005, lng: 36.83, accuracyM: 9 },
  ];
  // run-unique ids: envelope ids are globally unique, and a stale id from an
  // interrupted previous run must never turn this run's uploads into
  // id_conflict rejections
  const run = Date.now();
  const envelopes = [
    {
      id: `seed-${run}-unlock-0`,
      type: 'UNLOCK_FAILED' as const,
      capturedAt: new Date().toISOString(),
      payload: JSON.stringify({ attemptNo: 1, location: points[0] }),
    },
    ...points.map((location, index) => ({
      id: `seed-${run}-trail-${index}`,
      type: 'TRAIL_POINT' as const,
      capturedAt: new Date().toISOString(),
      payload: JSON.stringify(location),
    })),
  ].map((envelope) => ({ ...envelope, sha256: sha256Hex(envelope.payload) }));

  await evidenceService.ingestBatch(device, envelopes);

  const tokens = await sessionService.startSession(user, 'seed-script');

  return {
    userId,
    deviceId: device._id.toString(),
    ingestToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
};

const main = async (): Promise<void> => {
  if (config.nodeEnv !== 'development') {
    throw new Error('seed:dev only runs with NODE_ENV=development');
  }
  // generous timeouts: dev machines under load (iCloud sync, IDEs) can make
  // even a local handshake sluggish, and a seed script should out-wait that
  await mongoose.connect(config.mongodbUri, {
    serverSelectionTimeoutMS: 60_000,
    connectTimeoutMS: 60_000,
    socketTimeoutMS: 120_000,
  });

  const result = await seed();

  console.log(
    [
      '--- seeded ---',
      `email:        ${SEED_EMAIL}`,
      `password:     ${SEED_PASSWORD}`,
      `userId:       ${result.userId}`,
      `deviceId:     ${result.deviceId}`,
      `ingestToken:  ${result.ingestToken}`,
      `accessToken:  ${result.accessToken}`,
      `refreshToken: ${result.refreshToken}`,
      '',
      'Try: GET /api/v1/episodes, then /api/v1/episodes/:id/trail and /pack',
    ].join('\n'),
  );

  await mongoose.disconnect();
};

// require.main guard: the jest suite imports seed() without running main
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
