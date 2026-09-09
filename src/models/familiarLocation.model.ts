import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

/**
 * An owner-registered familiar place (home, work, ...). INTERPRETATION ONLY:
 * familiarity never relaxes the threshold, the episode, or an alert - by
 * design this model is never imported by evidence ingestion or episode
 * opening (docs/f3-location-trail-scoping.md). It exists so reports can say
 * "the device left familiar location *home* at ~HH:MM" - the strongest cue
 * that a phone is in someone else's pocket.
 */
export interface IFamiliarLocation extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  label: string;
  lat: number;
  lng: number;
  /** How close a fix must be to count as "at" this place. */
  radiusM: number;
  createdAt: Date;
  updatedAt: Date;
}

const familiarLocationSchema = new Schema<IFamiliarLocation>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    label: { type: String, required: true, trim: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    radiusM: { type: Number, required: true, default: 200 },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

// one place per name per owner - "home" cannot silently exist twice
familiarLocationSchema.index({ user: 1, label: 1 }, { unique: true });

export const FamiliarLocation = model<IFamiliarLocation>(
  'FamiliarLocation',
  familiarLocationSchema,
);
export default FamiliarLocation;
