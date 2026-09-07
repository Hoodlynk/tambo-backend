import type { Types } from 'mongoose';
import config from '../config/config';
import type { IDevice } from '../models/device.model';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { IEvidenceEnvelope } from '../models/evidenceEnvelope.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import { sha256Hex } from '../utils/tokens';
import * as episodeService from './episode.service';
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
}

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

export const ingestBatch = async (
  device: IDevice,
  envelopes: EnvelopeInput[],
): Promise<IngestResult> => {
  let openEpisode = await episodeService.findOpenForDevice(device._id);
  const results: EnvelopeAck[] = [];
  let sawUnlockFailure = false;

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
        expiresAt: openEpisode ? episodeExpiry() : routineExpiry(),
      });

      if (input.type === 'UNLOCK_FAILED') sawUnlockFailure = true;
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

  if (!openEpisode && sawUnlockFailure) {
    openEpisode = await maybeOpenByThreshold(device);
    if (openEpisode) {
      return {
        results,
        episodeId: openEpisode._id.toString(),
        episodeOpened: true,
      };
    }
  }

  return {
    results,
    ...(openEpisode ? { episodeId: openEpisode._id.toString() } : {}),
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
  lastAttemptAt: string | null;
  /** Most recent failed attempts, newest first (capped). */
  recent: { capturedAt: string; receivedAt: string }[];
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

  const [inWindow, recent] = await Promise.all([
    EvidenceEnvelope.countDocuments({
      device: device._id,
      type: 'UNLOCK_FAILED',
      receivedAt: { $gte: windowStart },
    }),
    EvidenceEnvelope.find({ device: device._id, type: 'UNLOCK_FAILED' })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .select('capturedAt receivedAt'),
  ]);

  return {
    inWindow,
    toThreshold: Math.max(0, device.failedUnlockThreshold - inWindow),
    threshold: device.failedUnlockThreshold,
    windowMinutes: config.evidence.thresholdWindowMinutes,
    lastAttemptAt: recent[0]?.receivedAt.toISOString() ?? null,
    recent: recent.map((envelope) => ({
      capturedAt: envelope.capturedAt.toISOString(),
      receivedAt: envelope.receivedAt.toISOString(),
    })),
  };
};

// re-exported so server.ts's retention interval has one import site
export { sweepExpiredMedia } from './storage/media.storage';
