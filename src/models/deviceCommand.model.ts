import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const COMMAND_TYPES = ['snapshot', 'locate', 'ring'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** The cameras an owner may ask a snapshot command to use. */
export const COMMAND_CAMERAS = ['front', 'back'] as const;
export type CommandCamera = (typeof COMMAND_CAMERAS)[number];

/**
 * Stored states. "expired" is deliberately NOT stored: it is a function of
 * the clock (an outstanding command past `expiresAt`), so it can never go
 * stale waiting for a sweeper. See `presentStatus` in the service.
 */
export const COMMAND_STATUSES = [
  'pending',
  'delivered',
  'completed',
  'failed',
  'cancelled',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** What the API reports: the stored states plus the derived one. */
export type PresentedCommandStatus = CommandStatus | 'expired';

/**
 * Something the owner asked their stolen phone to do (B2): take a snapshot
 * burst, report a location fix, or ring. Created only while an episode is
 * open and bound to it, so a command is part of one incident's record and
 * never a standing surveillance channel.
 *
 * Delivery is at-least-once: an outstanding command is handed to the device
 * on every poll and ingest response until a result arrives, it expires, or
 * the owner cancels it - the device dedups on the id. Results come back as
 * ordinary evidence envelopes carrying `commandId`, so what the phone did in
 * answer is hashed, timestamped, and in the pack like everything else.
 *
 * No TTL index: the row is the incident's audit trail ("owner asked for a
 * location at 14:02; it arrived at 14:03") and lives as long as the device's
 * episodes do; device removal deletes both.
 */
export interface IDeviceCommand extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  device: Types.ObjectId;
  episode: Types.ObjectId;
  type: CommandType;
  params: {
    /** snapshot only: which cameras to fire. */
    cameras?: CommandCamera[];
    /** ring only: how long to ring. */
    durationSeconds?: number;
  };
  status: CommandStatus;
  expiresAt: Date;
  /** First time the device was handed the command (poll or ingest reply). */
  deliveredAt?: Date;
  /** First result envelope's server receipt time. */
  completedAt?: Date;
  failedAt?: Date;
  /** The device's own short reason, e.g. "camera_unavailable". */
  failureReason?: string;
  cancelledAt?: Date;
  /** Result envelopes received so far (a snapshot answers with many). */
  resultCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const deviceCommandSchema = new Schema<IDeviceCommand>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    episode: {
      type: Schema.Types.ObjectId,
      ref: 'TheftEpisode',
      required: true,
    },
    type: { type: String, enum: COMMAND_TYPES, required: true },
    params: {
      cameras: { type: [String], enum: COMMAND_CAMERAS, default: undefined },
      durationSeconds: { type: Number },
    },
    status: {
      type: String,
      enum: COMMAND_STATUSES,
      default: 'pending',
      required: true,
    },
    expiresAt: { type: Date, required: true },
    deliveredAt: { type: Date },
    completedAt: { type: Date },
    failedAt: { type: Date },
    failureReason: { type: String },
    cancelledAt: { type: Date },
    resultCount: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// the device's poll and the owner's list: one device's commands, newest first
deviceCommandSchema.index({ device: 1, status: 1, createdAt: -1 });
// cancel-on-resolve: everything outstanding in one episode
deviceCommandSchema.index({ episode: 1, status: 1 });

export const DeviceCommand = model<IDeviceCommand>(
  'DeviceCommand',
  deviceCommandSchema,
);
export default DeviceCommand;
