import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { EnvelopeType } from '../models/evidenceEnvelope.model';
import TheftEpisode from '../models/theftEpisode.model';
import type { ITheftEpisode } from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import { haversineMeters } from '../utils/geo';
import { parseLocation } from './evidenceLocation';
import * as familiarLocationService from './familiarLocation.service';
import type { FamiliarMatch } from './familiarLocation.service';

/**
 * The episode trail read model (F3): the location-bearing envelopes of one
 * episode turned into an ordered path, classified static vs moving, and
 * annotated with the owner's familiar locations. Read-only over data F-B
 * already ingested - no new collection, no effect on thresholds or alerts.
 *
 * Models are used directly (not episode.service) to keep the import graph
 * acyclic: episode -> delivery -> pack -> trail must not loop back.
 */

export type Movement = 'static' | 'moving' | 'unknown';

export interface TrailPoint {
  /** Server receipt time - the authoritative ordering clock. */
  at: Date;
  /** The DEVICE's claim of when the fix was taken - recorded, never trusted.
   *  Matters when an offline device uploads a buffered trail in one batch. */
  capturedAt: Date;
  /** Which evidence type carried the fix: UNLOCK_FAILED, TRAIL_POINT or PHOTO. */
  source: EnvelopeType;
  lat: number;
  lng: number;
  accuracyM?: number;
  /** The familiar place this fix is inside, when the owner registered one. */
  familiar: FamiliarMatch | null;
}

export interface FamiliarDeparture {
  label: string;
  /** Receipt time of the first fix outside the familiar radius. */
  at: Date;
}

export interface EpisodeTrail {
  movement: Movement;
  points: TrailPoint[];
  /**
   * "Left familiar location *home* at ~HH:MM" - the strongest theft cue. Set
   * when a moving trail was inside a familiar radius and later fixes left it
   * (the LAST such departure). Never set for static trails: accuracy wobble
   * at a boundary must not read as a departure.
   */
  leftFamiliar: FamiliarDeparture | null;
}

/**
 * A trail is static when every fix stays within this radius of the first fix
 * (widened when the fixes themselves are less accurate than it).
 */
const STATIC_RADIUS_FLOOR_M = 150;

/**
 * Fixes coarser than this (cell-tower grade) are shown in the trail but
 * EXCLUDED from movement classification: one 2km-accuracy fix must not widen
 * the static radius until a phone crossing town reads as "stayed in place" -
 * that would erase the strongest theft cue from the pack.
 */
const CLASSIFICATION_ACCURACY_CEILING_M = 250;

/**
 * The evidence types that may carry a location fix. A snapshot burst (F4)
 * is pinned to where the phone was when the camera fired, so its frames are
 * trail fixes too - the place a photo was taken is exactly what the owner
 * wants to see next to it.
 */
export const LOCATION_BEARING_TYPES: readonly EnvelopeType[] = [
  'UNLOCK_FAILED',
  'TRAIL_POINT',
  'PHOTO',
];

/** Bounded read: extremely long trails keep their NEWEST fixes (the current
 *  location always matters most); the cap is far beyond a realistic episode. */
export const TRAIL_POINT_CAP = 5000;

const classifyOver = (
  points: Pick<TrailPoint, 'lat' | 'lng' | 'accuracyM'>[],
): Movement => {
  if (points.length < 2) return 'unknown';
  const worstAccuracy = points.reduce(
    (worst, point) => Math.max(worst, point.accuracyM ?? 0),
    0,
  );
  const staticRadiusM = Math.max(STATIC_RADIUS_FLOOR_M, 2 * worstAccuracy);
  const [first, ...rest] = points;
  if (!first) return 'unknown';
  return rest.every((point) => haversineMeters(first, point) <= staticRadiusM)
    ? 'static'
    : 'moving';
};

/**
 * static if every fix is within max(150m, 2x worst accuracy) of the first.
 * Classified on the PRECISE fixes when at least two exist (so one coarse
 * cell-tower fix cannot widen the radius until a real move reads as static);
 * with only coarse fixes available - the typical GPS-denied theft posture -
 * classification falls back to the whole set with the accuracy-widened
 * radius: displacement far beyond the fixes' own error is still decisive
 * movement, and must still produce the leftFamiliar cue.
 */
export const classifyMovement = (
  points: Pick<TrailPoint, 'lat' | 'lng' | 'accuracyM'>[],
): Movement => {
  const reliable = points.filter(
    (point) => (point.accuracyM ?? 0) <= CLASSIFICATION_ACCURACY_CEILING_M,
  );
  return reliable.length >= 2 ? classifyOver(reliable) : classifyOver(points);
};

const findDeparture = (points: TrailPoint[]): FamiliarDeparture | null => {
  let departure: FamiliarDeparture | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous?.familiar && current && !current.familiar) {
      departure = { label: previous.familiar.label, at: current.at };
    }
  }

  // a trail that ENDS back inside the place it departed has not "left" it -
  // a walk around the block must not put a bold theft cue in a police
  // document. Ending inside a DIFFERENT familiar place does not suppress it:
  // a phone that left home and sits at the owner's gym still left home.
  const last = points[points.length - 1];
  if (departure && last?.familiar?.label === departure.label) return null;
  return departure;
};

/** The fields a trail needs from an evidence envelope. */
export interface TrailEnvelope {
  type: EnvelopeType;
  payload: string;
  receivedAt: Date;
  capturedAt: Date;
}

/**
 * The pure core: envelopes (already loaded, e.g. by the pack builder) plus
 * the owner's familiar places in, a classified and annotated trail out.
 * Envelopes without a usable fix are simply not trail points - callers that
 * care about them as liveness evidence count them separately (the pack does).
 */
export const trailFromEnvelopes = (
  envelopes: TrailEnvelope[],
  familiarPlaces: Awaited<ReturnType<typeof familiarLocationService.list>>,
): EpisodeTrail => {
  const points: TrailPoint[] = [];
  for (const envelope of envelopes) {
    if (!LOCATION_BEARING_TYPES.includes(envelope.type)) continue;
    const location = parseLocation(envelope.payload);
    if (!location) continue;
    points.push({
      at: envelope.receivedAt,
      capturedAt: envelope.capturedAt,
      source: envelope.type,
      ...location,
      familiar: familiarLocationService.matchFamiliar(familiarPlaces, location),
    });
  }

  const movement = classifyMovement(points);

  return {
    movement,
    points,
    leftFamiliar: movement === 'moving' ? findDeparture(points) : null,
  };
};

/** Assembles the trail for an episode the caller has already authorized. */
export const buildEpisodeTrail = async (
  episode: ITheftEpisode,
): Promise<EpisodeTrail> => {
  const [envelopes, familiarPlaces] = await Promise.all([
    // newest-first + cap keeps the CURRENT location under pathological
    // volumes, then restored to chronological order for the trail
    EvidenceEnvelope.find({
      episode: episode._id,
      type: { $in: LOCATION_BEARING_TYPES },
    })
      .sort({ receivedAt: -1 })
      .limit(TRAIL_POINT_CAP)
      .select('type payload receivedAt capturedAt')
      .exec(),
    // an ownerless partner phone (B4) has no familiar places to interpret by
    episode.user
      ? familiarLocationService.list(episode.user.toString())
      : Promise.resolve([]),
  ]);

  return trailFromEnvelopes(envelopes.reverse(), familiarPlaces);
};

/** The owner's trail for one of their episodes; 404s indistinguishably. */
export const getTrail = async (
  userId: string,
  episodeId: string,
): Promise<EpisodeTrail> => {
  const episode = await TheftEpisode.findOne({ _id: episodeId, user: userId });
  if (!episode)
    throw AppError.notFound('Episode not found.', 'episode_not_found');
  return buildEpisodeTrail(episode);
};
