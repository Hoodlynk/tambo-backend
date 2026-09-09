import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const LEGAL_DOCS = ['terms', 'privacy'] as const;
export type LegalDoc = (typeof LEGAL_DOCS)[number];

/**
 * One user's acceptance of one VERSION of one legal document. Rows are an
 * audit trail: they are never updated or deleted, a new document version gets
 * a new row. `scrolledToEnd` is the client's attestation that the acceptance
 * control only unlocked after the user reached the bottom of the document -
 * recorded because consent-UX claims are worthless without a record.
 */
export interface ILegalAcceptance extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  doc: LegalDoc;
  version: string;
  /** The document URL as served at acceptance time - what the user saw. */
  url: string;
  scrolledToEnd: boolean;
  acceptedAt: Date;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const legalAcceptanceSchema = new Schema<ILegalAcceptance>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    doc: { type: String, enum: LEGAL_DOCS, required: true },
    version: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    scrolledToEnd: { type: Boolean, required: true },
    acceptedAt: { type: Date, required: true },
    userAgent: { type: String, trim: true },
    ip: { type: String, trim: true },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      // audit-only fields: nothing that serializes an acceptance (now or in a
      // future endpoint) should ship the recorded IP / user agent back out
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.ip;
        delete ret.userAgent;
        return ret;
      },
    },
  },
);

// one row per (user, doc, version): re-accepting the same version is a no-op,
// and the unique index makes a concurrent double-submit converge on one row
legalAcceptanceSchema.index({ user: 1, doc: 1, version: 1 }, { unique: true });

export const LegalAcceptance = model<ILegalAcceptance>(
  'LegalAcceptance',
  legalAcceptanceSchema,
);
export default LegalAcceptance;
