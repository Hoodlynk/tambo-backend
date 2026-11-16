import type { Types } from 'mongoose';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { IEvidenceEnvelope } from '../models/evidenceEnvelope.model';
import TheftEpisode from '../models/theftEpisode.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import { mapsLink, parseLocation } from './evidenceLocation';
import type { EvidenceLocation } from './evidenceLocation';
import { parseSnapshot } from './evidenceSnapshot';
import type { SnapshotCamera, SnapshotTrigger } from './evidenceSnapshot';
import * as familiarLocationService from './familiarLocation.service';
import type { FamiliarMatch } from './familiarLocation.service';
import { openMedia } from './storage/media.storage';

/**
 * The snapshot read model (F4): an episode's PHOTO envelopes grouped back
 * into the bursts the phone captured them in, each burst pinned to the place
 * and the moment it happened. Read-only over data F-B already ingested; the
 * owner is the only reader (buddies see photos in the PDF pack, never here).
 *
 * Models are used directly (not episode.service) to keep the import graph
 * acyclic, as trail.service does.
 */

export interface SnapshotFrame {
  envelopeId: string;
  seq: number | null;
  camera: SnapshotCamera;
  /** Server receipt time - the authoritative clock. */
  receivedAt: Date;
  /** The device's claim - shown, never trusted. */
  capturedAt: Date;
  /** The media hash once bytes landed, else the payload hash. */
  sha256: string;
  bytes?: number;
  contentType?: string;
  /** False while the envelope exists but its bytes have not arrived yet. */
  hasMedia: boolean;
  headingDeg?: number;
}

export interface SnapshotBurst {
  burstId: string;
  trigger: SnapshotTrigger;
  /** Receipt time of the first frame. */
  at: Date;
  capturedAt: Date;
  /** The first location any frame of the burst carried. */
  location: (EvidenceLocation & { mapsLink: string }) | null;
  familiar: FamiliarMatch | null;
  /** Frames the device said the burst would have, when it said. */
  expectedFrames: number | null;
  cameras: Record<SnapshotCamera, number>;
  frames: SnapshotFrame[];
}

export interface EpisodeSnapshots {
  bursts: SnapshotBurst[];
  summary: { bursts: number; frames: number; framesWithMedia: number };
}

/** The fields the grouping needs from an envelope. */
export type SnapshotEnvelope = Pick<
  IEvidenceEnvelope,
  | 'envelopeId'
  | 'type'
  | 'payload'
  | 'sha256'
  | 'receivedAt'
  | 'capturedAt'
  | 'burstId'
  | 'camera'
  | 'trigger'
  | 'seq'
  | 'mediaFileId'
  | 'mediaSha256'
  | 'mediaBytes'
  | 'mediaContentType'
>;

/**
 * The pure core: PHOTO envelopes in server-receipt order, the owner's
 * familiar places, bursts out. Envelopes ingested before F4 carry no burst
 * columns; they read as a burst of one keyed on their own id, so an old
 * episode's photos still show.
 */
export const burstsFromEnvelopes = (
  envelopes: SnapshotEnvelope[],
  familiarPlaces: Awaited<ReturnType<typeof familiarLocationService.list>>,
): EpisodeSnapshots => {
  const byBurst = new Map<string, SnapshotBurst>();
  let frames = 0;
  let framesWithMedia = 0;

  for (const envelope of envelopes) {
    if (envelope.type !== 'PHOTO') continue;
    const meta = parseSnapshot(envelope.payload);
    const burstId = envelope.burstId ?? meta.burstId ?? envelope.envelopeId;
    const camera = envelope.camera ?? meta.camera;
    const location = parseLocation(envelope.payload);

    let burst = byBurst.get(burstId);
    if (!burst) {
      burst = {
        burstId,
        trigger: envelope.trigger ?? meta.trigger,
        at: envelope.receivedAt,
        capturedAt: envelope.capturedAt,
        location: null,
        familiar: null,
        expectedFrames: meta.count,
        cameras: { front: 0, back: 0, unknown: 0 },
        frames: [],
      };
      byBurst.set(burstId, burst);
    }
    if (!burst.location && location) {
      burst.location = { ...location, mapsLink: mapsLink(location) };
      burst.familiar = familiarLocationService.matchFamiliar(
        familiarPlaces,
        location,
      );
    }
    if (burst.expectedFrames === null && meta.count !== null) {
      burst.expectedFrames = meta.count;
    }
    burst.cameras[camera] += 1;

    const hasMedia = Boolean(envelope.mediaFileId);
    frames += 1;
    if (hasMedia) framesWithMedia += 1;
    burst.frames.push({
      envelopeId: envelope.envelopeId,
      seq: envelope.seq ?? meta.seq,
      camera,
      receivedAt: envelope.receivedAt,
      capturedAt: envelope.capturedAt,
      sha256: envelope.mediaSha256 ?? envelope.sha256,
      ...(envelope.mediaBytes !== undefined
        ? { bytes: envelope.mediaBytes }
        : {}),
      ...(envelope.mediaContentType
        ? { contentType: envelope.mediaContentType }
        : {}),
      hasMedia,
      ...(meta.headingDeg !== undefined ? { headingDeg: meta.headingDeg } : {}),
    });
  }

  // frames within a burst follow the device's sequence when it gave one,
  // receipt order otherwise (a retried frame may land after its successor)
  for (const burst of byBurst.values()) {
    burst.frames.sort((a, b) => {
      if (a.seq !== null && b.seq !== null && a.seq !== b.seq)
        return a.seq - b.seq;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
  }

  return {
    bursts: [...byBurst.values()],
    summary: { bursts: byBurst.size, frames, framesWithMedia },
  };
};

const getOwnedEpisode = async (
  userId: string,
  episodeId: string,
): Promise<ITheftEpisode> => {
  const episode = await TheftEpisode.findOne({ _id: episodeId, user: userId });
  if (!episode)
    throw AppError.notFound('Episode not found.', 'episode_not_found');
  return episode;
};

/** Assembles the bursts for an episode the caller has already authorized. */
export const buildEpisodeSnapshots = async (
  episode: ITheftEpisode,
): Promise<EpisodeSnapshots> => {
  const [envelopes, familiarPlaces] = await Promise.all([
    EvidenceEnvelope.find({ episode: episode._id, type: 'PHOTO' })
      .sort({ receivedAt: 1 })
      .select(
        'envelopeId type payload sha256 receivedAt capturedAt burstId camera trigger seq mediaFileId mediaSha256 mediaBytes mediaContentType',
      )
      .exec(),
    familiarLocationService.list(episode.user.toString()),
  ]);
  return burstsFromEnvelopes(envelopes, familiarPlaces);
};

/** The owner's snapshot bursts for one of their episodes; 404s indistinguishably. */
export const getSnapshots = async (
  userId: string,
  episodeId: string,
): Promise<EpisodeSnapshots> =>
  buildEpisodeSnapshots(await getOwnedEpisode(userId, episodeId));

export interface SnapshotMedia {
  stream: NodeJS.ReadableStream;
  contentType: string;
  bytes: number;
  sha256: string;
}

/**
 * The bytes of one frame, for the owner's app. Scoped twice: the episode
 * must be the caller's, and the envelope must belong to that episode - an
 * envelope id alone never opens a photo.
 */
export const openSnapshotMedia = async (
  userId: string,
  episodeId: string,
  envelopeId: string,
): Promise<SnapshotMedia> => {
  const episode = await getOwnedEpisode(userId, episodeId);
  const envelope = await EvidenceEnvelope.findOne({
    envelopeId,
    episode: episode._id,
    type: 'PHOTO',
  }).select('mediaFileId mediaSha256 mediaBytes mediaContentType');
  if (!envelope) {
    throw AppError.notFound('Snapshot not found.', 'snapshot_not_found');
  }
  if (!envelope.mediaFileId || !envelope.mediaSha256) {
    throw AppError.notFound(
      'The photo bytes have not arrived from the device yet.',
      'media_not_available',
    );
  }
  return {
    stream: openMedia(envelope.mediaFileId as Types.ObjectId),
    contentType: envelope.mediaContentType ?? 'application/octet-stream',
    bytes: envelope.mediaBytes ?? 0,
    sha256: envelope.mediaSha256,
  };
};
