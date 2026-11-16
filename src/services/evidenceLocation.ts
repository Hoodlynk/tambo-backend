import type { Types } from 'mongoose';
import EvidenceEnvelope from '../models/evidenceEnvelope.model';
import type { EnvelopeType } from '../models/evidenceEnvelope.model';

/**
 * Best-effort location extraction from evidence payloads. The payload stays
 * OPAQUE for integrity purposes (it is hashed and stored byte-for-byte); this
 * module only *reads* it leniently so reports and alert emails can say WHERE
 * an attempt happened. An unparseable payload is simply "no location" - never
 * an error, never a rejection.
 *
 * Contract with the device (docs/f1-client-contract.md): a payload may carry
 *   { "location": { "lat": -1.2921, "lng": 36.8219, "accuracyM": 12 } }
 * or the same three fields at the top level. TRAIL_POINT payloads use the
 * same shape.
 */

export interface EvidenceLocation {
  lat: number;
  lng: number;
  /** GPS accuracy radius in metres, when the device reported one. */
  accuracyM?: number;
}

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const fromObject = (candidate: unknown): EvidenceLocation | null => {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const record = candidate as Record<string, unknown>;

  const lat = asFiniteNumber(record.lat);
  const lng = asFiniteNumber(record.lng);
  if (lat === null || lng === null) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  // devices in the field send either spelling; accept both
  const accuracyM =
    asFiniteNumber(record.accuracyM) ?? asFiniteNumber(record.accuracy);
  return {
    lat,
    lng,
    ...(accuracyM !== null && accuracyM >= 0 ? { accuracyM } : {}),
  };
};

/** Parses a payload string for a location; null when it does not carry one. */
export const parseLocation = (payload: string): EvidenceLocation | null => {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return fromObject(record.location) ?? fromObject(record);
  } catch {
    return null;
  }
};

export interface LastKnownLocation {
  location: EvidenceLocation;
  /** Server receipt time of the envelope that carried it. */
  at: Date;
  /** Which evidence type carried it: UNLOCK_FAILED, TRAIL_POINT or PHOTO. */
  source: EnvelopeType;
}

/**
 * The device's most recent reported location, from the latest location-bearing
 * envelope (failed unlocks, trail points, snapshot frames). Scans a bounded
 * window of recent envelopes; older history is the trail's concern (F3), not
 * this lookup's.
 */
export const lastKnownLocation = async (
  deviceId: Types.ObjectId,
): Promise<LastKnownLocation | null> => {
  const recent = await EvidenceEnvelope.find({
    device: deviceId,
    type: { $in: ['UNLOCK_FAILED', 'TRAIL_POINT', 'PHOTO'] },
  })
    .sort({ receivedAt: -1 })
    .limit(25)
    .select('type payload receivedAt');

  for (const envelope of recent) {
    const location = parseLocation(envelope.payload);
    if (location) {
      return { location, at: envelope.receivedAt, source: envelope.type };
    }
  }
  return null;
};

/** A link anyone can open from the alert email. */
export const mapsLink = (location: EvidenceLocation): string =>
  `https://maps.google.com/?q=${location.lat},${location.lng}`;
