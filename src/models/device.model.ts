import { Schema, model } from 'mongoose';
import type { Document, Types } from 'mongoose';

export const DEVICE_STATUSES = ['active', 'stolen'] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/**
 * A phone enrolled for protection. IMEIs are OWNER-ENTERED: Android 10+ does
 * not let the app read them, so the source of truth is the human (see the
 * feasibility triage). They matter because the police report and the operator
 * IMEI-blacklist request are keyed on them.
 *
 * `ingestTokenHash` is the device's evidence-upload credential (issued at
 * enrolment, shown once, stored hashed). It is scoped to ingest only and is
 * deliberately not a user session: a stolen phone must keep uploading evidence
 * even after the owner revokes their sessions, and a leaked ingest token must
 * never grant account access.
 */
export interface IDevice extends Document<Types.ObjectId> {
  _id: Types.ObjectId;
  /** Absent on a provisioned phone nobody has linked yet (B4). */
  user?: Types.ObjectId;
  name: string;
  imeis: string[];
  make: string;
  /** Named deviceModel because `model` collides with mongoose Document.model(). */
  deviceModel: string;
  colour?: string;
  /** Free text: vendor, date, price, receipt no - whatever the owner has. */
  purchaseInfo?: string;
  status: DeviceStatus;
  /**
   * Failed credential attempts (within the server's counting window) that
   * auto-open a theft episode. The F1 spike suggests 2-3; owner-tunable.
   */
  failedUnlockThreshold: number;
  ingestTokenHash?: string;
  /** The partner fleet this phone belongs to, when enrolled under one. */
  partner?: Types.ObjectId;
  /** Partner-supplied hardware serial, when the factory has one. */
  serial?: string;
  /** Set when a partner provisioned the phone rather than an owner enrolling it. */
  provisionedAt?: Date;
  /** The one-shot claim credential a provisioned phone presents (hashed). */
  provisioningTokenHash?: string;
  /** When the phone claimed its ingest token. */
  claimedAt?: Date;
  /**
   * The app install that claimed (hashed). A claim whose response was lost
   * may be retried by the SAME install; any other install is refused.
   */
  claimInstallIdHash?: string;
  /** When a person linked the phone to their account. */
  linkedAt?: Date;
  /**
   * Random id the app generates once per install. Makes enrolment idempotent:
   * signing in again on the same phone re-issues that device's token instead
   * of enrolling a duplicate.
   */
  installId?: string;
  /** Server time of the device's last upload or heartbeat. */
  lastSeenAt?: Date;
  /**
   * Server time of the latest failed unlock or locked-screen boot that has
   * not since been followed by a successful unlock. Arms the quiet alert.
   */
  suspiciousAt?: Date;
  /** When the owner was last told this device went quiet (one per silence). */
  quietAlertedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<IDevice>(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      // nobody answers for an ownerless phone unless a partner does
      required: function (this: IDevice) {
        return !this.partner;
      },
    },
    name: { type: String, required: true, trim: true },
    // may start empty: the app enrols itself at sign-in, before the owner has
    // typed IMEIs in (Android will not let it read them)
    imeis: { type: [String], default: [] },
    make: { type: String, required: true, trim: true },
    deviceModel: { type: String, required: true, trim: true },
    colour: { type: String, trim: true },
    purchaseInfo: { type: String, trim: true },
    status: { type: String, enum: DEVICE_STATUSES, default: 'active' },
    failedUnlockThreshold: { type: Number, default: 3, min: 1, max: 10 },
    partner: { type: Schema.Types.ObjectId, ref: 'Partner', index: true },
    serial: { type: String, trim: true },
    provisionedAt: { type: Date },
    provisioningTokenHash: {
      type: String,
      select: false,
      index: { unique: true, sparse: true },
    },
    claimedAt: { type: Date },
    claimInstallIdHash: { type: String, select: false },
    linkedAt: { type: Date },
    // never selected by default; the ingest-auth middleware queries BY hash
    ingestTokenHash: {
      type: String,
      select: false,
      index: { unique: true, sparse: true },
    },
    installId: { type: String, trim: true },
    lastSeenAt: { type: Date },
    suspiciousAt: { type: Date },
    quietAlertedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: {
      versionKey: false,
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.ingestTokenHash;
        delete ret.provisioningTokenHash;
        delete ret.claimInstallIdHash;
        return ret;
      },
    },
  },
);

// a partner never provisions the same handset twice: a factory re-run
// reissues the existing row's token instead (multikey, so any shared IMEI
// collides). Owner-entered IMEIs are not unique and stay out of it.
deviceSchema.index(
  { partner: 1, imeis: 1 },
  {
    unique: true,
    partialFilterExpression: { provisionedAt: { $exists: true } },
  },
);
// one device per (owner, install): re-enrolling the same phone converges
deviceSchema.index(
  { user: 1, installId: 1 },
  { unique: true, partialFilterExpression: { installId: { $type: 'string' } } },
);
// the quiet-device sweep
deviceSchema.index({ status: 1, lastSeenAt: 1 });

export const Device = model<IDevice>('Device', deviceSchema);
export default Device;
