import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

/**
 * A partner's machine credential (X-Api-Key). Shown once at issue; only the
 * SHA-256 hash is stored, plus a short prefix so a partner and support can
 * tell keys apart in a list without either side holding the secret.
 * Revocation is a timestamp, not a delete, so "which key did that" stays
 * answerable after rotation.
 */
export interface IPartnerApiKey extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  partner: Types.ObjectId;
  name: string;
  prefix: string;
  keyHash: string;
  createdBy: Types.ObjectId;
  revokedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const partnerApiKeySchema = new Schema<IPartnerApiKey>(
  {
    partner: {
      type: Schema.Types.ObjectId,
      ref: 'Partner',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true, unique: true, select: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.keyHash;
        return ret;
      },
    },
  },
);

export const PartnerApiKey = model<IPartnerApiKey>(
  'PartnerApiKey',
  partnerApiKeySchema,
);
export default PartnerApiKey;
