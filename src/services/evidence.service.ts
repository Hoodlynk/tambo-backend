import type { Types } from 'mongoose';
import config from '../config/config';
import Device from '../models/device.model';
import type { IDevice } from '../models/device.model';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { IEvidenceEnvelope } from '../models/evidenceEnvelope.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import User from '../models/user.model';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import { sha256Hex } from '../utils/tokens';
import * as deviceCommandService from './deviceCommand.service';
import type { DeviceCommandView } from './deviceCommand.service';
import { entitlementsFor } from './entitlements';
import type { Entitlements, SnapshotPolicy } from './entitlements';
import { parseCommandRef } from './evidenceCommand';
import type { CommandRef } from './evidenceCommand';
import * as episodeService from './episode.service';
import * as partnerEvents from './partnerEvents';
import type { ReceivedBurst } from './partnerEvents';
import * as partnerService from './partner.service';
import { parseLocation } from './evidenceLocation';
import type { EvidenceLocation } from './evidenceLocation';
import { parseSnapshot } from './evidenceSnapshot';
import { extendMediaExpiry, saveMedia } from './storage/media.storage';
import type { EnvelopeInput } from '../validation/evidence.schema';

/**
 * Evidence ingest: capture cheaply on the device, deliver relentlessly, ACK
 * idempotently. Every envelope is verified against its own hash at receipt -
 * from that moment the (payload, sha256, receivedAt) triple is the item's
 * tamper-evidence, feeding the pack's integrity manifest (F-C).
 */

export type EnvelopeAckStatus = 'acked' | 'duplicate' | 'rejected';

export interface EnvelopeAck {
  id: string;
  status: EnvelopeAckStatus;
  reason?: string;
}

export interface IngestResult {
  results: EnvelopeAck[];
  /** Present when the device has an open episode after this batch. */
  episodeId?: string;
  /** True when THIS batch crossed the threshold and opened it. */
  episodeOpened?: boolean;
  /**
   * Advisory TRAIL_POINT cadence while an episode is open, tuned to the
   * owner's plan. Advice, not enforcement - evidence is never refused.
   */
  trailCadenceSeconds?: number;
  /**
   * Advisory camera-burst policy while an episode is open (F4), tuned to the
   * owner's plan. Advice on how much to capture; evidence is never refused.
   */
  snapshotPolicy?: SnapshotPolicy;
  /**
   * Outstanding remote commands for this device (B2), oldest first; absent
   * when there are none. Re-sent until answered - the device dedups on id.
   */
  pendingCommands?: DeviceCommandView[];
}

/**
 * The burst columns a PHOTO envelope carries (F4). Read from the payload at
 * ingest so the read model never has to re-parse; a payload without them is
 * a legacy single photo and gets no columns at all.
 */
const snapshotColumns = (
  input: EnvelopeInput,
): Partial<
  Pick<IEvidenceEnvelope, 'burstId' | 'camera' | 'trigger' | 'seq'>
> => {
  if (input.type !== 'PHOTO') return {};
  const meta = parseSnapshot(input.payload);
  return {
    ...(meta.burstId ? { burstId: meta.burstId } : {}),
    camera: meta.camera,
    trigger: meta.trigger,
    ...(meta.seq !== null ? { seq: meta.seq } : {}),
  };
};

const routineExpiry = (): Date =>
  new Date(
    Date.now() + config.evidence.retentionRoutineDays * 24 * 60 * 60 * 1000,
  );

const episodeExpiry = (): Date =>
  new Date(
    Date.now() + config.evidence.retentionEpisodeDays * 24 * 60 * 60 * 1000,
  );

/**
 * When an episode opens, evidence received shortly BEFORE it (the failed
 * unlocks that led to the threshold, the last routine trail point) is part of
 * the incident: attach it and extend its retention - media files included,
 * since the TTL monitor cannot cascade into GridFS.
 */
const backAttachRecent = async (episode: ITheftEpisode): Promise<void> => {
  const since = new Date(
    Date.now() - config.evidence.backAttachMinutes * 60 * 1000,
  );
  const expiresAt = episodeExpiry();

  const recent = await EvidenceEnvelope.find({
    device: episode.device,
    episode: { $exists: false },
    receivedAt: { $gte: since },
  }).select('_id mediaFileId');

  if (recent.length === 0) return;

  await EvidenceEnvelope.updateMany(
    { _id: { $in: recent.map((envelope) => envelope._id) } },
    { $set: { episode: episode._id, expiresAt } },
  );

  for (const envelope of recent) {
    if (envelope.mediaFileId)
      await extendMediaExpiry(envelope.mediaFileId, expiresAt);
  }
};

/**
 * Counts recent failed-unlock evidence by SERVER receipt time (a thief cannot
 * dodge the threshold by lying about the device clock) and opens an episode
 * when the device's threshold is crossed.
 */
const maybeOpenByThreshold = async (
  device: IDevice,
): Promise<ITheftEpisode | null> => {
  const windowStart = new Date(
    Date.now() - config.evidence.thresholdWindowMinutes * 60 * 1000,
  );

  const failures = await EvidenceEnvelope.countDocuments({
    device: device._id,
    type: 'UNLOCK_FAILED',
    receivedAt: { $gte: windowStart },
  });

  if (failures < device.failedUnlockThreshold) return null;

  const { episode } = await episodeService.openEpisode(device, 'device');
  await backAttachRecent(episode);
  return episode;
};

/**
 * The plan the device's capture advice follows: the owner's, or for a phone
 * nobody has linked yet, the plan its partner grants at signup (B4).
 */
const adviceFor = async (device: IDevice): Promise<Entitlements | null> => {
  if (!device.user) {
    return entitlementsFor({
      plan: await partnerService.fleetPlan(device.partner),
    });
  }
  const owner = await User.findById(device.user).select('plan planExpiresAt');
  return owner ? entitlementsFor(owner) : null;
};

/**
 * STATUS payloads the watchdog reads. Everything else in a STATUS payload
 * stays opaque evidence; a payload that is not this shape is simply ignored.
 */
const statusEvent = (
  payload: string,
): { event?: unknown; locked?: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === 'object'
      ? (parsed as { event?: unknown; locked?: unknown })
      : null;
  } catch {
    return null;
  }
};

type Suspicion = 'raised' | 'cleared' | 'unchanged';

/**
 * Walks this batch's newly stored envelopes in device order and returns where
 * the suspicion ends up. A failed unlock or a boot that stayed on the lock
 * screen raises it; a successful unlock (only ever sent to close a failed
 * run) clears it - so the owner who mistypes and then gets in never trips
 * the quiet alert, while a thief who never gets in does.
 */
const suspicionAfter = (stored: EnvelopeInput[]): Suspicion => {
  let outcome: Suspicion = 'unchanged';
  const ordered = [...stored].sort(
    (a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt),
  );

  for (const input of ordered) {
    if (input.type === 'UNLOCK_FAILED') {
      outcome = 'raised';
    } else if (input.type === 'STATUS') {
      const status = statusEvent(input.payload);
      if (status?.event === 'BOOT' && status.locked === true) {
        outcome = 'raised';
      } else if (status?.event === 'UNLOCK_SUCCEEDED') {
        outcome = 'cleared';
      }
    }
  }
  return outcome;
};

/**
 * Every contact from the device is a sign of life: stamp lastSeenAt, and
 * apply this batch's effect on the suspicion marker.
 */
const recordContact = async (
  device: IDevice,
  suspicion: Suspicion = 'unchanged',
): Promise<void> => {
  const now = new Date();
  const update: Record<string, unknown> = { $set: { lastSeenAt: now } };
  if (suspicion === 'raised') {
    (update.$set as Record<string, unknown>).suspiciousAt = now;
  } else if (suspicion === 'cleared') {
    update.$unset = { suspiciousAt: '' };
  }
  await Device.updateOne({ _id: device._id }, update);
};

/** A check-in with nothing to upload - keeps the quiet alert from firing. */
export const heartbeat = async (
  device: IDevice,
): Promise<{ episodeId?: string }> => {
  await recordContact(device);
  const episode = await episodeService.findOpenForDevice(device._id);
  return episode ? { episodeId: episode._id.toString() } : {};
};

export const ingestBatch = async (
  device: IDevice,
  envelopes: EnvelopeInput[],
): Promise<IngestResult> => {
  let openEpisode = await episodeService.findOpenForDevice(device._id);
  const results: EnvelopeAck[] = [];
  const stored: EnvelopeInput[] = [];
  let sawUnlockFailure = false;

  // command answers are resolved for the whole batch up front: one lookup,
  // and only this device's own commands ever get linked or completed
  const commandRefs = new Map<string, CommandRef>();
  for (const input of envelopes) {
    const ref = parseCommandRef(input.payload);
    if (ref) commandRefs.set(input.id, ref);
  }
  const ownCommands = await deviceCommandService.ownCommandIds(device._id, [
    ...new Set([...commandRefs.values()].map((ref) => ref.commandId)),
  ]);
  const answered: CommandRef[] = [];
  // first receipts of episode photos, one per burst, for the partner (B5)
  const bursts = new Map<string, ReceivedBurst>();

  for (const input of envelopes) {
    // integrity first: the hash must match the exact bytes sent
    if (sha256Hex(input.payload) !== input.sha256.toLowerCase()) {
      results.push({
        id: input.id,
        status: 'rejected',
        reason: 'hash_mismatch',
      });
      continue;
    }

    const ref = commandRefs.get(input.id);
    const answers = ref && ownCommands.has(ref.commandId) ? ref : null;

    try {
      await EvidenceEnvelope.create({
        envelopeId: input.id,
        user: device.user,
        device: device._id,
        ...(openEpisode ? { episode: openEpisode._id } : {}),
        type: input.type,
        capturedAt: new Date(input.capturedAt),
        receivedAt: new Date(),
        payload: input.payload,
        sha256: input.sha256.toLowerCase(),
        ...snapshotColumns(input),
        ...(answers ? { commandId: answers.commandId } : {}),
        expiresAt: openEpisode ? episodeExpiry() : routineExpiry(),
      });

      if (input.type === 'UNLOCK_FAILED') sawUnlockFailure = true;
      // only a first receipt counts: a retried duplicate is not a new result
      if (answers) answered.push(answers);
      if (openEpisode && input.type === 'PHOTO') {
        const meta = parseSnapshot(input.payload);
        const key = meta.burstId ?? input.id;
        if (!bursts.has(key)) {
          bursts.set(key, {
            key,
            burstId: meta.burstId,
            camera: meta.camera,
            trigger: meta.trigger,
          });
        }
      }
      stored.push(input);
      results.push({ id: input.id, status: 'acked' });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      // retries after a half-acked batch are safe; an id claimed by ANOTHER
      // device is not a retry, it's a collision or abuse
      const existing = await EvidenceEnvelope.findOne({
        envelopeId: input.id,
      }).select('device');
      if (existing && existing.device.equals(device._id)) {
        results.push({ id: input.id, status: 'duplicate' });
      } else {
        results.push({
          id: input.id,
          status: 'rejected',
          reason: 'id_conflict',
        });
      }
    }
  }

  if (answered.length > 0) {
    await deviceCommandService.recordResults(device._id, answered);
  }
  if (openEpisode && bursts.size > 0) {
    partnerEvents.snapshotsReceived(device, openEpisode._id, [
      ...bursts.values(),
    ]);
  }

  // duplicates were applied when they first landed; only new envelopes count
  await recordContact(device, suspicionAfter(stored));

  let episodeOpened = false;
  if (!openEpisode && sawUnlockFailure) {
    openEpisode = await maybeOpenByThreshold(device);
    episodeOpened = openEpisode !== null;
  }

  // plan-tuned ADVISORY only ("how often should I ping?"): entitlements shape
  // the client's cadence, never whether evidence is accepted
  const advice = openEpisode ? await adviceFor(device) : null;

  // commands only exist while an episode is open (and are cancelled when it
  // resolves), so a routine ingest skips the lookup entirely
  const pending = openEpisode
    ? await deviceCommandService.deliverOutstanding(device._id)
    : [];

  return {
    results,
    ...(openEpisode ? { episodeId: openEpisode._id.toString() } : {}),
    ...(episodeOpened ? { episodeOpened: true } : {}),
    ...(advice
      ? {
          trailCadenceSeconds: advice.trailCadenceSeconds,
          snapshotPolicy: advice.snapshotPolicy,
        }
      : {}),
    ...(pending.length > 0
      ? { pendingCommands: pending.map(deviceCommandService.toDeviceView) }
      : {}),
  };
};

export interface MediaAck {
  envelopeId: string;
  bytes: number;
  /** False when this exact content was already stored (idempotent retry). */
  stored: boolean;
}

/**
 * Attaches the photo bytes to a PHOTO envelope. Hash-verified against the
 * X-Content-Sha256 header; idempotent for the same content, a conflict for
 * different content under the same envelope.
 */
export const attachMedia = async (
  device: IDevice,
  envelopeId: string,
  content: Buffer,
  contentType: string,
  declaredSha256: string,
): Promise<MediaAck> => {
  const envelope = await EvidenceEnvelope.findOne({
    envelopeId,
    device: device._id,
  });
  if (!envelope) {
    throw AppError.notFound('Envelope not found.', 'envelope_not_found');
  }
  if (envelope.type !== 'PHOTO') {
    throw AppError.badRequest(
      'Media can only attach to a PHOTO envelope.',
      'not_photo_envelope',
    );
  }

  const actual = sha256Hex(content);

  if (actual !== declaredSha256.toLowerCase()) {
    throw AppError.badRequest(
      'Media hash does not match the content.',
      'hash_mismatch',
    );
  }

  if (envelope.mediaFileId) {
    if (envelope.mediaSha256 === actual) {
      return {
        envelopeId,
        bytes: envelope.mediaBytes ?? content.length,
        stored: false,
      };
    }
    throw AppError.conflict(
      'This envelope already has different media attached.',
      'media_conflict',
    );
  }

  const stored = await saveMedia(content, contentType, {
    envelopeId,
    device: device._id.toString(),
    expiresAt: envelope.expiresAt,
  });

  envelope.mediaFileId = stored.fileId;
  envelope.mediaSha256 = actual;
  envelope.mediaContentType = contentType;
  envelope.mediaBytes = stored.bytes;
  await envelope.save();

  return { envelopeId, bytes: stored.bytes, stored: true };
};

/** Everything in one episode, server-time ordered - pack assembly (F-C). */
export const listForEpisode = (
  episodeId: Types.ObjectId,
): Promise<IEvidenceEnvelope[]> =>
  EvidenceEnvelope.find({ episode: episodeId }).sort({ receivedAt: 1 }).exec();

/** How many envelopes a device has stored (device management UI). */
export const countForDevice = (deviceId: Types.ObjectId): Promise<number> =>
  EvidenceEnvelope.countDocuments({ device: deviceId }).exec();

export interface UnlockAttemptReport {
  /** Failed unlocks in the threshold-counting window (server receipt time). */
  inWindow: number;
  /** How many more before an episode auto-opens (0 once it would). */
  toThreshold: number;
  threshold: number;
  windowMinutes: number;
  /** How far back `recent` reaches under the owner's plan; null = full. The
   *  client can say "showing the last N days" instead of looking broken. */
  historyDays: number | null;
  lastAttemptAt: string | null;
  /** Most recent failed attempts, newest first (capped). */
  recent: {
    capturedAt: string;
    receivedAt: string;
    /** Where the attempt happened, when the payload carried a location. */
    location: EvidenceLocation | null;
  }[];
}

/**
 * The owner's "has anyone been trying my PIN?" report. Reads UNLOCK_FAILED
 * evidence by SERVER receipt time (the same authority the threshold uses, so a
 * lying device clock cannot skew what the owner sees). Surfaces below-threshold
 * activity that would otherwise be invisible until an episode opens.
 */
export const unlockActivity = async (
  device: IDevice,
  limit = 20,
): Promise<UnlockAttemptReport> => {
  const windowStart = new Date(
    Date.now() - config.evidence.thresholdWindowMinutes * 60 * 1000,
  );

  // the plan bounds how far back the owner's HISTORY view reaches - it never
  // touches threshold counting (safety) or episode evidence/packs
  const owner = await User.findById(device.user).select('plan planExpiresAt');
  const historyDays = owner ? entitlementsFor(owner).historyDays : null;
  const historyFilter =
    historyDays !== null
      ? {
          receivedAt: {
            $gte: new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000),
          },
        }
      : {};

  const [inWindow, recent] = await Promise.all([
    EvidenceEnvelope.countDocuments({
      device: device._id,
      type: 'UNLOCK_FAILED',
      receivedAt: { $gte: windowStart },
    }),
    EvidenceEnvelope.find({
      device: device._id,
      type: 'UNLOCK_FAILED',
      ...historyFilter,
    })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .select('capturedAt receivedAt payload'),
  ]);

  return {
    inWindow,
    toThreshold: Math.max(0, device.failedUnlockThreshold - inWindow),
    threshold: device.failedUnlockThreshold,
    windowMinutes: config.evidence.thresholdWindowMinutes,
    historyDays,
    lastAttemptAt: recent[0]?.receivedAt.toISOString() ?? null,
    recent: recent.map((envelope) => ({
      capturedAt: envelope.capturedAt.toISOString(),
      receivedAt: envelope.receivedAt.toISOString(),
      location: parseLocation(envelope.payload),
    })),
  };
};

// re-exported so server.ts's retention interval has one import site
export { sweepExpiredMedia } from './storage/media.storage';
