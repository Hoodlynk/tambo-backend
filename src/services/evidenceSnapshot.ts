/**
 * Best-effort reading of a PHOTO envelope's payload as a SNAPSHOT: one frame
 * of a camera burst the phone took while it was being tampered with (F4,
 * docs/f4-snapshots-scoping.md). Like evidenceLocation.ts, this only READS the
 * payload leniently - the string stays opaque, hashed and stored byte for
 * byte - so a malformed or legacy payload is "a burst of one from an unknown
 * camera", never a rejection.
 *
 * Contract with the device:
 *   { "burstId": "uuid", "seq": 0, "count": 3, "camera": "front",
 *     "trigger": "failed_unlock", "location": {...}, "headingDeg": 240 }
 */

import type {
  SnapshotCamera,
  SnapshotTrigger,
} from '../models/evidenceEnvelope.model';

export type { SnapshotCamera, SnapshotTrigger };

export interface SnapshotMeta {
  /** Groups the frames of one capture; null when the payload names none. */
  burstId: string | null;
  /** Position within the burst, 0-based; null when absent. */
  seq: number | null;
  /** How many frames the device intended to send in this burst. */
  count: number | null;
  camera: SnapshotCamera;
  trigger: SnapshotTrigger;
  /** Compass heading of the back camera at capture, degrees, when reported. */
  headingDeg?: number;
}

const LEGACY: SnapshotMeta = {
  burstId: null,
  seq: null,
  count: null,
  camera: 'unknown',
  trigger: 'unknown',
};

const BURST_ID = /^[\w-]{8,64}$/;

const asNonNegativeInt = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

const asEnum = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;

/** Parses a payload string for snapshot metadata; legacy defaults otherwise. */
export const parseSnapshot = (payload: string): SnapshotMeta => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return LEGACY;
  }
  if (typeof parsed !== 'object' || parsed === null) return LEGACY;
  const record = parsed as Record<string, unknown>;

  const burstId =
    typeof record.burstId === 'string' && BURST_ID.test(record.burstId)
      ? record.burstId
      : null;
  const heading =
    typeof record.headingDeg === 'number' &&
    Number.isFinite(record.headingDeg) &&
    record.headingDeg >= 0 &&
    record.headingDeg < 360
      ? record.headingDeg
      : null;

  return {
    burstId,
    seq: asNonNegativeInt(record.seq),
    count: asNonNegativeInt(record.count),
    // "unknown" is never something a device should CLAIM; map it to the
    // same bucket as "absent" so the read model has one meaning for it
    camera: asEnum(record.camera, ['front', 'back'] as const) ?? 'unknown',
    trigger:
      asEnum(record.trigger, [
        'failed_unlock',
        'episode_open',
        'owner_request',
        'periodic',
        'tamper',
      ] as const) ?? 'unknown',
    ...(heading !== null ? { headingDeg: heading } : {}),
  };
};
