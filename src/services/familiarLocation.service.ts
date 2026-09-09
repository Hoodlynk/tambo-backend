import FamiliarLocation from '../models/familiarLocation.model';
import type { IFamiliarLocation } from '../models/familiarLocation.model';
import { AppError } from '../utils/appError';
import { haversineMeters } from '../utils/geo';
import type { GeoPoint } from '../utils/geo';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import type {
  FamiliarLocationInput,
  FamiliarLocationUpdateInput,
} from '../validation/familiarLocation.schema';

/**
 * Familiar locations are context for INTERPRETATION only. This module is read
 * by report paths (trail, pack, alert wording) and must never be imported by
 * evidence ingestion or episode opening - familiarity never suppresses,
 * delays, or raises anything (docs/f3-location-trail-scoping.md).
 */

/** A handful of places, not a location diary. */
const MAX_PER_USER = 10;

export const create = async (
  userId: string,
  input: FamiliarLocationInput,
): Promise<IFamiliarLocation> => {
  // count-then-create is not atomic, but the cap is a product bound, not a
  // security invariant - a racy 11th entry costs nothing
  const count = await FamiliarLocation.countDocuments({ user: userId });
  if (count >= MAX_PER_USER) {
    throw AppError.conflict(
      `You can register at most ${MAX_PER_USER} familiar locations.`,
      'familiar_location_limit',
    );
  }

  try {
    return await FamiliarLocation.create({ user: userId, ...input });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(
        'You already have a familiar location with this label.',
        'familiar_location_exists',
      );
    }
    throw error;
  }
};

export const list = (userId: string): Promise<IFamiliarLocation[]> =>
  FamiliarLocation.find({ user: userId }).sort({ createdAt: 1 }).exec();

export const update = async (
  userId: string,
  id: string,
  input: FamiliarLocationUpdateInput,
): Promise<IFamiliarLocation> => {
  try {
    const location = await FamiliarLocation.findOneAndUpdate(
      { _id: id, user: userId },
      { $set: input },
      { new: true, runValidators: true },
    );
    if (!location) {
      throw AppError.notFound(
        'Familiar location not found.',
        'familiar_location_not_found',
      );
    }
    return location;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw AppError.conflict(
        'You already have a familiar location with this label.',
        'familiar_location_exists',
      );
    }
    throw error;
  }
};

export const remove = async (userId: string, id: string): Promise<void> => {
  const result = await FamiliarLocation.deleteOne({ _id: id, user: userId });
  if (result.deletedCount === 0) {
    throw AppError.notFound(
      'Familiar location not found.',
      'familiar_location_not_found',
    );
  }
};

export interface FamiliarMatch {
  label: string;
  /** Distance from the fix to the place's centre, whole metres. */
  distanceM: number;
}

/**
 * The familiar place a fix is inside, if any - the nearest one when radii
 * overlap. Pure; callers load the user's locations once per report.
 */
export const matchFamiliar = (
  locations: IFamiliarLocation[],
  fix: GeoPoint,
): FamiliarMatch | null => {
  let best: FamiliarMatch | null = null;
  for (const place of locations) {
    const distanceM = haversineMeters(place, fix);
    if (distanceM <= place.radiusM && (!best || distanceM < best.distanceM)) {
      best = { label: place.label, distanceM: Math.round(distanceM) };
    }
  }
  return best;
};
