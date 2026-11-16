import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const EPISODE_STATUSES = ['open', 'resolved'] as const;
export const EPISODE_OPENERS = ['owner', 'device', 'buddy'] as const;
export const EPISODE_RESOLUTIONS = ['recovered', 'closed'] as const;

export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];
export type EpisodeOpener = (typeof EPISODE_OPENERS)[number];
export type EpisodeResolution = (typeof EPISODE_RESOLUTIONS)[number];

/**
 * One theft incident - the unit every piece of evidence groups under (the
 * product docs' `trailId`), and the unit a report/claim is generated for.
 *
 * Opened by the OWNER (mark-as-stolen from another device, or the one-tap
 * link in a quiet alert), by the DEVICE itself (failed-unlock threshold via
 * evidence ingest, F-B), or by an accepted BUDDY on the owner's behalf - the
 * owner's only phone is often the stolen one. Unlock detection must never be
 * the only trigger (F1 deep-dive S4).
 *
 * Episode state drives evidence retention: routine envelopes live 90 days,
 * an open episode's evidence is extended to 12 months (F-B).
 */
export interface ITheftEpisode extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  /**
   * Absent while the device has no owner (B4): a provisioned phone can still
   * detect a theft. Linking the phone later hands its history to the owner.
   */
  user?: Types.ObjectId;
  device: Types.ObjectId;
  status: EpisodeStatus;
  openedBy: EpisodeOpener;
  openedAt: Date;
  resolvedAt?: Date;
  resolution?: EpisodeResolution;
  /** Owner-supplied context ("snatched at Kencom stage ~18:30"). */
  note?: string;
  /** The buddy who reported it, when openedBy is 'buddy'. */
  reportedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const theftEpisodeSchema = new Schema<ITheftEpisode>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    device: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    status: { type: String, enum: EPISODE_STATUSES, default: 'open' },
    openedBy: { type: String, enum: EPISODE_OPENERS, required: true },
    openedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
    resolution: { type: String, enum: EPISODE_RESOLUTIONS },
    note: { type: String, trim: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// device-scoped listing, newest first
theftEpisodeSchema.index({ device: 1, openedAt: -1 });

// at most one OPEN episode per device, enforced by the database not convention
theftEpisodeSchema.index(
  { device: 1 },
  { unique: true, partialFilterExpression: { status: 'open' } },
);

export const TheftEpisode = model<ITheftEpisode>(
  'TheftEpisode',
  theftEpisodeSchema,
);
export default TheftEpisode;
