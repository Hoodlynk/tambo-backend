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
  /** Which evidence type carried the fix - UNLOCK_FAILED or TRAIL_POINT. */
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

/** static if every fix is within max(150m, 2x worst accuracy) of the first. */
export const classifyMovement = (
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

const findDeparture = (points: TrailPoint[]): FamiliarDeparture | null => {
  let departure: FamiliarDeparture | null = null;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (previous?.familiar && current && !current.familiar) {
      departure = { label: previous.familiar.label, at: current.at };
    }
  }
  return departure;
};

/** Assembles the trail for an episode the caller has already authorized. */
export const buildEpisodeTrail = async (
  episode: ITheftEpisode,
): Promise<EpisodeTrail> => {
  const [envelopes, familiarPlaces] = await Promise.all([
    EvidenceEnvelope.find({
      episode: episode._id,
      type: { $in: ['UNLOCK_FAILED', 'TRAIL_POINT'] },
    })
      .sort({ receivedAt: 1 })
      .select('type payload receivedAt')
      .exec(),
    familiarLocationService.list(episode.user.toString()),
  ]);

  // an envelope without a usable fix is simply not a trail point
  const points: TrailPoint[] = [];
  for (const envelope of envelopes) {
    const location = parseLocation(envelope.payload);
    if (!location) continue;
    points.push({
      at: envelope.receivedAt,
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
