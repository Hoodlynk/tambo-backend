import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';
import { USER_PLANS } from './user.model';
import type { UserPlan } from './user.model';

export const PARTNER_TYPES = [
  'oem',
  'insurer',
  'telco',
  'enterprise',
  'bnpl',
] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

export const PARTNER_STATUSES = ['active', 'suspended'] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];

/** What a partner may switch off. Evidence upload is deliberately absent. */
export const PARTNER_FEATURES = [
  'buddies',
  'plans',
  'familiarLocations',
] as const;
export type PartnerFeature = (typeof PARTNER_FEATURES)[number];

export interface PartnerBrand {
  displayName: string;
  logoUrl?: string;
  colors: { primary: string; onPrimary: string };
  supportUrl?: string;
  supportEmail?: string;
}

export interface AlertRecipient {
  email: string;
  name?: string;
}

/**
 * A white-label partner (docs/white-label-scoping.md). `code` is the public
 * handle a branded build carries and users type at signup, so it is stable
 * and never reused; `_id` never leaves the admin surface.
 *
 * `alertRecipients` is stored now and read from B4/B5 on: episodes on
 * partner devices with no owner, and partner webhooks.
 */
export interface IPartner extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  code: string;
  name: string;
  type: PartnerType;
  status: PartnerStatus;
  brand: PartnerBrand;
  features: Record<PartnerFeature, boolean>;
  /** Granted at signup with planSource "partner"; absent = no grant. */
  defaultPlan?: UserPlan;
  alertRecipients: AlertRecipient[];
  createdAt: Date;
  updatedAt: Date;
}

const featureFlag = { type: Boolean, default: true };

const partnerSchema = new Schema<IPartner>(
  {
    code: { type: String, required: true, unique: true, lowercase: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: PARTNER_TYPES, required: true },
    status: { type: String, enum: PARTNER_STATUSES, default: 'active' },
    brand: {
      displayName: { type: String, required: true, trim: true },
      logoUrl: { type: String },
      colors: {
        primary: { type: String, required: true },
        onPrimary: { type: String, required: true },
      },
      supportUrl: { type: String },
      supportEmail: { type: String },
    },
    features: {
      buddies: featureFlag,
      plans: featureFlag,
      familiarLocations: featureFlag,
    },
    defaultPlan: { type: String, enum: USER_PLANS },
    alertRecipients: {
      type: [
        {
          _id: false,
          email: { type: String, required: true, lowercase: true },
          name: { type: String },
        },
      ],
      default: [],
    },
  },
  { timestamps: true, toJSON: { versionKey: false } },
);

export const Partner = model<IPartner>('Partner', partnerSchema);
export default Partner;
