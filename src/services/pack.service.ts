import Device from '../models/device.model';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import PackDelivery from '../models/packDelivery.model';
import TheftEpisode from '../models/theftEpisode.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import User from '../models/user.model';
import { AppError } from '../utils/appError';
import { packPublicKeyBase64, signManifest } from '../utils/signing';
import { mapsLink } from './evidenceLocation';
import * as familiarLocationService from './familiarLocation.service';
import { burstsFromEnvelopes } from './snapshot.service';
import { LOCATION_BEARING_TYPES, trailFromEnvelopes } from './trail.service';
import type { Movement } from './trail.service';

/**
 * The evidence pack: the messy signals of a theft turned into the dossier a
 * Kenyan owner needs to file a police report (OB), obtain an abstract on
 * eCitizen, submit an insurance claim, and request IMEI blacklisting
 * (Evidence doc S4). Assembled SERVER-side - the phone may be gone; the
 * server always has the data.
 *
 * Models are used directly (not the domain services) to keep the import graph
 * acyclic: evidence -> episode -> delivery -> pack.
 */

export interface PackTrailPoint {
  /** Server receipt time - the authoritative clock. */
  receivedAt: string;
  /** The device's claim of capture time - shown, never trusted; matters when
   *  an offline device uploads a buffered trail in one batch. */
  capturedAt: string;
  /** Which evidence type carried the fix - UNLOCK_FAILED or TRAIL_POINT. */
  source: string;
  lat: number;
  lng: number;
  accuracyM?: number;
  mapsLink: string;
  /** The owner-registered familiar place this fix is inside, if any. */
  familiar: { label: string; distanceM: number } | null;
}

export interface PackTrailSummary {
  /** static = one place; moving = a path; unknown = under 2 reliable fixes. */
  movement: Movement;
  /** Set when a moving trail left a familiar place - the strongest theft cue. */
  leftFamiliar: { label: string; at: string } | null;
  /**
   * Location-bearing envelope types (failed unlocks, trail points, snapshot
   * frames) that arrived WITHOUT a usable fix (GPS-denied, malformed
   * coordinates). They are liveness evidence - the device reported in at
   * those times - and stay in the signed manifest.
   */
  pointsWithoutFix: number;
}

/**
 * One camera burst (F4): the frames the phone took in one go, pinned to the
 * place and moment. Where a thief was and what was around them, in order.
 */
export interface PackSnapshotSet {
  burstId: string;
  trigger: string;
  /** Server receipt time of the first frame. */
  receivedAt: string;
  capturedAt: string;
  location: {
    lat: number;
    lng: number;
    accuracyM?: number;
    mapsLink: string;
  } | null;
  familiar: { label: string; distanceM: number } | null;
  cameras: { front: number; back: number; unknown: number };
  frames: {
    envelopeId: string;
    seq: number | null;
    camera: string;
    receivedAt: string;
    sha256: string;
    bytes?: number;
    /** False when the bytes never arrived; the frame is still in the manifest. */
    hasMedia: boolean;
  }[];
}

export interface PackManifestItem {
  envelopeId: string;
  type: string;
  sha256: string;
  receivedAt: string;
  mediaSha256?: string;
}

export interface EvidencePack {
  version: 1;
  generatedAt: string;
  episode: {
    id: string;
    status: string;
    openedBy: string;
    openedAt: string;
    resolvedAt?: string;
    note?: string;
    firstAlertAt?: string;
  };
  owner: { name: string; email?: string };
  device: {
    name: string;
    imeis: string[];
    make: string;
    model: string;
    colour?: string;
    purchaseInfo?: string;
  };
  unlockAttempts: { capturedAt: string; receivedAt: string; detail: string }[];
  trail: PackTrailPoint[];
  trailSummary: PackTrailSummary;
  /** Camera bursts in receipt order (F4). */
  snapshotSets: PackSnapshotSet[];
  /** Every PHOTO frame, flat - kept for clients built before snapshotSets. */
  photos: {
    envelopeId: string;
    receivedAt: string;
    sha256: string;
    bytes?: number;
  }[];
  otherEvidence: { envelopeId: string; type: string; receivedAt: string }[];
  actionChecklist: string[];
  integrity: {
    statement: string;
    algorithm: 'Ed25519';
    publicKeyBase64: string;
    manifest: PackManifestItem[];
    /** Signature over the CANONICAL manifest JSON (see canonicalManifest). */
    signatureBase64: string;
  };
}

/**
 * Kenya-mapped next steps (Evidence doc S4.1). Deliberately names the steps
 * and official portals without asserting phone numbers that rot.
 */
const ACTION_CHECKLIST = [
  'Block your SIM: call your mobile operator (Safaricom, Airtel, or Telkom) customer care from another phone and ask them to block the line.',
  'Report the theft at the nearest police station and record your OB (Occurrence Book) number.',
  'Apply for a police abstract on eCitizen (https://www.ecitizen.go.ke) - insurers require it.',
  'Ask your operator to blacklist the IMEI(s) listed in this pack so the phone cannot be used on Kenyan networks.',
  'Submit this pack, the OB number, and the abstract to your insurer to file the claim.',
];

const INTEGRITY_STATEMENT =
  'Each item below was hashed on receipt and this manifest is signed by Tambo. ' +
  'Verify by checking the Ed25519 signature over the canonical manifest JSON. ' +
  'This makes the pack a tamper-evident business record; it is not a forensic ' +
  'certification, and device-reported times may reflect an incorrect device clock.';

/** Deterministic bytes to sign: keys in fixed order, no whitespace variance. */
export const canonicalManifest = (
  items: PackManifestItem[],
  generatedAt: string,
): string =>
  JSON.stringify({
    generatedAt,
    items: items.map((item) => ({
      envelopeId: item.envelopeId,
      type: item.type,
      sha256: item.sha256,
      receivedAt: item.receivedAt,
      ...(item.mediaSha256 ? { mediaSha256: item.mediaSha256 } : {}),
    })),
  });

/** Loads an episode the caller owns, or 404s indistinguishably. */
export const getOwnedEpisode = async (
  userId: string,
  episodeId: string,
): Promise<ITheftEpisode> => {
  const episode = await TheftEpisode.findOne({ _id: episodeId, user: userId });
  if (!episode)
    throw AppError.notFound('Episode not found.', 'episode_not_found');
  return episode;
};

export const buildPack = async (
  userId: string,
  episodeId: string,
): Promise<EvidencePack> => {
  const episode = await getOwnedEpisode(userId, episodeId);

  const [owner, device, envelopes, firstAlert, familiarPlaces] =
    await Promise.all([
      User.findById(episode.user),
      Device.findById(episode.device),
      EvidenceEnvelope.find({ episode: episode._id })
        .sort({ receivedAt: 1 })
        .exec(),
      PackDelivery.findOne({ episode: episode._id, kind: 'first_alert' })
        .sort({ sentAt: 1 })
        .exec(),
      familiarLocationService.list(episode.user.toString()),
    ]);
  // the trail and the snapshot sets are computed from the envelopes already
  // in hand - the pack must not read the episode's evidence twice
  const episodeTrail = trailFromEnvelopes(envelopes, familiarPlaces);
  const snapshots = burstsFromEnvelopes(envelopes, familiarPlaces);

  if (!owner || !device) {
    throw AppError.notFound(
      'Episode records are incomplete.',
      'episode_not_found',
    );
  }

  const unlockAttempts = envelopes
    .filter((envelope) => envelope.type === 'UNLOCK_FAILED')
    .map((envelope) => ({
      capturedAt: envelope.capturedAt.toISOString(),
      receivedAt: envelope.receivedAt.toISOString(),
      detail: envelope.payload,
    }));

  // the F3 read model: every located fix (trail points AND failed unlocks),
  // familiar-annotated, classified static/moving. Fixless envelopes are noise
  // here; the manifest still lists every envelope.
  const trail: PackTrailPoint[] = episodeTrail.points.map((point) => ({
    receivedAt: point.at.toISOString(),
    capturedAt: point.capturedAt.toISOString(),
    source: point.source,
    lat: point.lat,
    lng: point.lng,
    ...(point.accuracyM !== undefined ? { accuracyM: point.accuracyM } : {}),
    // v1: link rather than rendered map image (features plan decision #3)
    mapsLink: mapsLink(point),
    familiar: point.familiar,
  }));

  const locationBearing = envelopes.filter((envelope) =>
    LOCATION_BEARING_TYPES.includes(envelope.type),
  ).length;

  const trailSummary: PackTrailSummary = {
    movement: episodeTrail.movement,
    leftFamiliar: episodeTrail.leftFamiliar
      ? {
          label: episodeTrail.leftFamiliar.label,
          at: episodeTrail.leftFamiliar.at.toISOString(),
        }
      : null,
    pointsWithoutFix: locationBearing - trail.length,
  };

  const snapshotSets: PackSnapshotSet[] = snapshots.bursts.map((burst) => ({
    burstId: burst.burstId,
    trigger: burst.trigger,
    receivedAt: burst.at.toISOString(),
    capturedAt: burst.capturedAt.toISOString(),
    location: burst.location
      ? {
          lat: burst.location.lat,
          lng: burst.location.lng,
          ...(burst.location.accuracyM !== undefined
            ? { accuracyM: burst.location.accuracyM }
            : {}),
          mapsLink: burst.location.mapsLink,
        }
      : null,
    familiar: burst.familiar,
    cameras: burst.cameras,
    frames: burst.frames.map((frame) => ({
      envelopeId: frame.envelopeId,
      seq: frame.seq,
      camera: frame.camera,
      receivedAt: frame.receivedAt.toISOString(),
      sha256: frame.sha256,
      ...(frame.bytes !== undefined ? { bytes: frame.bytes } : {}),
      hasMedia: frame.hasMedia,
    })),
  }));

  const photos = envelopes
    .filter((envelope) => envelope.type === 'PHOTO')
    .map((envelope) => ({
      envelopeId: envelope.envelopeId,
      receivedAt: envelope.receivedAt.toISOString(),
      sha256: envelope.mediaSha256 ?? envelope.sha256,
      ...(envelope.mediaBytes !== undefined
        ? { bytes: envelope.mediaBytes }
        : {}),
    }));

  const otherEvidence = envelopes
    .filter(
      (envelope) =>
        envelope.type === 'DEVICE_SNAPSHOT' || envelope.type === 'STATUS',
    )
    .map((envelope) => ({
      envelopeId: envelope.envelopeId,
      type: envelope.type,
      receivedAt: envelope.receivedAt.toISOString(),
    }));

  const manifest: PackManifestItem[] = envelopes.map((envelope) => ({
    envelopeId: envelope.envelopeId,
    type: envelope.type,
    sha256: envelope.sha256,
    receivedAt: envelope.receivedAt.toISOString(),
    ...(envelope.mediaSha256 ? { mediaSha256: envelope.mediaSha256 } : {}),
  }));

  const generatedAt = new Date().toISOString();

  return {
    version: 1,
    generatedAt,
    episode: {
      id: episode._id.toString(),
      status: episode.status,
      openedBy: episode.openedBy,
      openedAt: episode.openedAt.toISOString(),
      ...(episode.resolvedAt
        ? { resolvedAt: episode.resolvedAt.toISOString() }
        : {}),
      ...(episode.note ? { note: episode.note } : {}),
      ...(firstAlert ? { firstAlertAt: firstAlert.sentAt.toISOString() } : {}),
    },
    owner: { name: owner.name, ...(owner.email ? { email: owner.email } : {}) },
    device: {
      name: device.name,
      imeis: device.imeis,
      make: device.make,
      model: device.deviceModel,
      ...(device.colour ? { colour: device.colour } : {}),
      ...(device.purchaseInfo ? { purchaseInfo: device.purchaseInfo } : {}),
    },
    unlockAttempts,
    trail,
    trailSummary,
    snapshotSets,
    photos,
    otherEvidence,
    actionChecklist: ACTION_CHECKLIST,
    integrity: {
      statement: INTEGRITY_STATEMENT,
      algorithm: 'Ed25519',
      publicKeyBase64: packPublicKeyBase64,
      manifest,
      signatureBase64: signManifest(canonicalManifest(manifest, generatedAt)),
    },
  };
};
