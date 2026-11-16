import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

/**
 * The one-tap "mark my phone stolen" link in a quiet alert email. The owner
 * reading that email has, by definition, probably lost the phone their Tambo
 * session lives on - so the link itself is the credential.
 *
 * Same discipline as password-reset tokens: the mailed value is random and
 * opaque, only its SHA-256 is stored, it is single-use (`usedAt`), and a TTL
 * index removes it after expiry. It can do exactly one thing - open a theft
 * episode on one device - so a leaked link costs at most a false alarm.
 */
export interface IAlertActionToken extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  device: Types.ObjectId;
  tokenHash: string;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const alertActionTokenSchema = new Schema<IAlertActionToken>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    device: { type: Schema.Types.ObjectId, ref: 'Device', required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true, expires: 0 },
    usedAt: { type: Date },
  },
  { timestamps: true },
);

export const AlertActionToken = model<IAlertActionToken>(
  'AlertActionToken',
  alertActionTokenSchema,
);
export default AlertActionToken;
