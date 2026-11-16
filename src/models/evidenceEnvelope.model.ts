import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const ENVELOPE_TYPES = [
  'UNLOCK_FAILED',
  'TRAIL_POINT',
  'DEVICE_SNAPSHOT',
  'STATUS',
  'PHOTO',
] as const;
export type EnvelopeType = (typeof ENVELOPE_TYPES)[number];

/** Which camera a snapshot frame came from (F4). */
export const SNAPSHOT_CAMERAS = ['front', 'back', 'unknown'] as const;
export type SnapshotCamera = (typeof SNAPSHOT_CAMERAS)[number];

/** Why the device fired a snapshot burst (F4). */
export const SNAPSHOT_TRIGGERS = [
  'failed_unlock',
  'episode_open',
  'owner_request',
  'periodic',
  'tamper',
  'unknown',
] as const;
export type SnapshotTrigger = (typeof SNAPSHOT_TRIGGERS)[number];

/**
 * One self-contained unit of evidence, exactly as the device queued it
 * (Evidence doc S1.1). Two clocks, deliberately kept apart:
 *
 * - `capturedAt` is the DEVICE's claim - a device clock can be wrong, so it is
 *   recorded but never trusted for anything security-relevant.
 * - `receivedAt` is the SERVER's stamp - the authoritative timeline the
 *   integrity manifest (F-C) and the threshold counting rely on.
 *
 * `payload` is stored as the exact string the device sent; `sha256` was
 * verified against those bytes at receipt, so the pair is the item's
 * tamper-evidence. Photos add a GridFS file, hashed separately.
 *
 * `expiresAt` is retention-as-code: a TTL index deletes routine envelopes
 * after 90 days; attachment to a theft episode extends them to 12 months.
 */
export interface IEvidenceEnvelope extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  /** Client-generated id; the idempotency key for upload retries. */
  envelopeId: string;
  user: Types.ObjectId;
  device: Types.ObjectId;
  episode?: Types.ObjectId;
  type: EnvelopeType;
  capturedAt: Date;
  receivedAt: Date;
  payload: string;
  sha256: string;
  mediaFileId?: Types.ObjectId;
  mediaSha256?: string;
  mediaContentType?: string;
  mediaBytes?: number;
  /**
   * Snapshot burst columns (F4), PHOTO envelopes only. Copied out of the
   * payload at ingest so bursts can be grouped and indexed; the payload string
   * remains the evidence, these are a read model and carry no integrity weight.
   */
  burstId?: string;
  camera?: SnapshotCamera;
  trigger?: SnapshotTrigger;
  seq?: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const evidenceEnvelopeSchema = new Schema<IEvidenceEnvelope>(
  {
    envelopeId: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    episode: { type: Schema.Types.ObjectId, ref: 'TheftEpisode' },
    type: { type: String, enum: ENVELOPE_TYPES, required: true },
    capturedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    payload: { type: String, required: true },
    sha256: { type: String, required: true },
    mediaFileId: { type: Schema.Types.ObjectId },
    mediaSha256: { type: String },
    mediaContentType: { type: String },
    mediaBytes: { type: Number },
    burstId: { type: String },
    camera: { type: String, enum: SNAPSHOT_CAMERAS },
    trigger: { type: String, enum: SNAPSHOT_TRIGGERS },
    seq: { type: Number },
    // TTL index: retention enforced by the database, not a policy paragraph
    expiresAt: { type: Date, required: true, expires: 0 },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// threshold counting: recent UNLOCK_FAILED per device
evidenceEnvelopeSchema.index({ device: 1, type: 1, receivedAt: -1 });
// pack assembly (F-C): everything in one episode, in server-time order
evidenceEnvelopeSchema.index({ episode: 1, receivedAt: 1 });
// snapshot bursts (F4): the frames of one capture, in the device's order
evidenceEnvelopeSchema.index({ episode: 1, burstId: 1, seq: 1 });

export const EvidenceEnvelope = model<IEvidenceEnvelope>(
  'EvidenceEnvelope',
  evidenceEnvelopeSchema,
);
export default EvidenceEnvelope;
