import crypto from 'crypto';
import type { Types } from 'mongoose';
import Partner from '../models/partner.model';
import type {
  AlertRecipient,
  IPartner,
  PartnerType,
} from '../models/partner.model';
import PartnerApiKey from '../models/partnerApiKey.model';
import type { IPartnerApiKey } from '../models/partnerApiKey.model';
import type { PlanSource, UserPlan } from '../models/user.model';
import { AppError } from '../utils/appError';
import { isDuplicateKeyError } from '../utils/mongoErrors';
import { hashOpaqueToken } from '../utils/tokens';
import * as audit from './audit.service';
import type {
  PartnerCreateInput,
  PartnerUpdateInput,
} from '../validation/partner.schema';

/**
 * White-label partners (B3): the admin catalogue, partner API keys, and the
 * lookups signup / enrolment / client config use to resolve a partner code.
 * A suspended partner keeps its branding for phones already in the field but
 * cannot take new signups or authenticate its systems.
 */

/** Who a request authenticated as when it came in on a partner key. */
export interface PartnerPrincipal {
  partnerId: string;
  code: string;
  apiKeyId: string;
}

export interface PartnerKeyView {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The public face of a partner: what a partner's own system may read. */
export interface PartnerSummary {
  code: string;
  name: string;
  type: PartnerType;
}

const KEY_PREFIX = 'tpk_';
// enough to tell keys apart in a list; far too short to help a guesser
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8;

const toKeyView = (key: IPartnerApiKey): PartnerKeyView => ({
  id: key._id.toString(),
  name: key.name,
  prefix: key.prefix,
  createdAt: key.createdAt.toISOString(),
  lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
  revokedAt: key.revokedAt?.toISOString() ?? null,
});

export const toSummary = (partner: IPartner): PartnerSummary => ({
  code: partner.code,
  name: partner.name,
  type: partner.type,
});

const notFound = (): AppError =>
  AppError.notFound('Partner not found.', 'partner_not_found');

// --- Admin catalogue ---------------------------------------------------------

export const create = async (input: PartnerCreateInput): Promise<IPartner> => {
  try {
    return await Partner.create({
      code: input.code,
      name: input.name,
      type: input.type,
      brand: input.brand,
      ...(input.features ? { features: input.features } : {}),
      ...(input.defaultPlan ? { defaultPlan: input.defaultPlan } : {}),
      ...(input.alertRecipients
        ? { alertRecipients: input.alertRecipients }
        : {}),
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    throw AppError.conflict(
      'A partner with that code already exists.',
      'partner_code_taken',
    );
  }
};

export const list = (): Promise<IPartner[]> =>
  Partner.find().sort({ createdAt: -1 }).exec();

export const get = async (partnerId: string): Promise<IPartner> => {
  const partner = await Partner.findById(partnerId);
  if (!partner) throw notFound();
  return partner;
};

export const update = async (
  partnerId: string,
  input: PartnerUpdateInput,
): Promise<IPartner> => {
  const $set: Record<string, unknown> = {};
  const $unset: Record<string, 1> = {};

  for (const key of ['name', 'type', 'status', 'brand'] as const) {
    if (input[key] !== undefined) $set[key] = input[key];
  }
  if (input.alertRecipients) $set.alertRecipients = input.alertRecipients;
  // flags are set one by one so a partial patch leaves the others alone
  for (const [flag, value] of Object.entries(input.features ?? {})) {
    $set[`features.${flag}`] = value;
  }
  if (input.defaultPlan === null) $unset.defaultPlan = 1;
  else if (input.defaultPlan) $set.defaultPlan = input.defaultPlan;

  const partner = await Partner.findByIdAndUpdate(
    partnerId,
    {
      ...(Object.keys($set).length > 0 ? { $set } : {}),
      ...(Object.keys($unset).length > 0 ? { $unset } : {}),
    },
    { new: true, runValidators: true },
  );
  if (!partner) throw notFound();
  return partner;
};

// --- API keys ----------------------------------------------------------------

export const issueKey = async (
  partnerId: string,
  adminUserId: string,
  name: string,
): Promise<{ key: PartnerKeyView; apiKey: string }> => {
  const partner = await get(partnerId);
  const apiKey = `${KEY_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  const key = await PartnerApiKey.create({
    partner: partner._id,
    name,
    prefix: apiKey.slice(0, DISPLAY_PREFIX_LENGTH),
    keyHash: hashOpaqueToken(apiKey),
    createdBy: adminUserId,
  });
  audit.record(adminUserId, 'partner_key_issued', {
    meta: { partner: partner.code, prefix: key.prefix },
  });
  return { key: toKeyView(key), apiKey };
};

export const listKeys = async (
  partnerId: string,
): Promise<PartnerKeyView[]> => {
  const partner = await get(partnerId);
  const keys = await PartnerApiKey.find({ partner: partner._id }).sort({
    createdAt: -1,
  });
  return keys.map(toKeyView);
};

/** Idempotent: revoking a revoked key is a no-op, not an error. */
export const revokeKey = async (
  partnerId: string,
  keyId: string,
  adminUserId: string,
): Promise<void> => {
  const key = await PartnerApiKey.findOne({ _id: keyId, partner: partnerId });
  if (!key) {
    throw AppError.notFound('API key not found.', 'partner_key_not_found');
  }
  if (key.revokedAt) return;
  key.revokedAt = new Date();
  await key.save();
  audit.record(adminUserId, 'partner_key_revoked', {
    meta: { prefix: key.prefix },
  });
};

/** Resolves a presented key, or null when unknown, revoked or suspended. */
export const authenticateApiKey = async (
  apiKey: string,
): Promise<PartnerPrincipal | null> => {
  const key = await PartnerApiKey.findOne({
    keyHash: hashOpaqueToken(apiKey),
    revokedAt: { $exists: false },
  });
  if (!key) return null;
  const partner = await Partner.findById(key.partner);
  if (!partner || partner.status !== 'active') return null;

  // usage tracking must never block or fail the request
  void PartnerApiKey.updateOne(
    { _id: key._id },
    { $set: { lastUsedAt: new Date() } },
  ).catch(() => undefined);
  return {
    partnerId: partner._id.toString(),
    code: partner.code,
    apiKeyId: key._id.toString(),
  };
};

// --- Partner codes from signup, enrolment and client config ------------------

/** Any partner by code, suspended included: phones in the field keep branding. */
export const findByCode = (code: string): Promise<IPartner | null> =>
  Partner.findOne({ code }).exec();

export const findById = (
  partnerId: Types.ObjectId | string,
): Promise<IPartner | null> => Partner.findById(partnerId).exec();

/**
 * A partner code supplied with a new signup or enrolment. Unknown and
 * suspended answer the same, so a suspended partner's code cannot be probed.
 */
export const resolveForEnrolment = async (code: string): Promise<IPartner> => {
  const partner = await findByCode(code);
  if (!partner || partner.status !== 'active') {
    throw AppError.badRequest(
      'That partner code is not recognised.',
      'unknown_partner',
    );
  }
  return partner;
};

/**
 * The account fields a partner signup sets. A partner with a default plan
 * grants it with planSource "partner", which store billing must never
 * overwrite (docs/plans-api.md).
 */
export const signupFields = (
  partner: IPartner | null,
): {
  partner?: Types.ObjectId;
  plan: UserPlan;
  planSource: PlanSource;
} => {
  if (!partner) return { plan: 'free', planSource: 'self' };
  if (!partner.defaultPlan || partner.defaultPlan === 'free') {
    return { partner: partner._id, plan: 'free', planSource: 'self' };
  }
  return {
    partner: partner._id,
    plan: partner.defaultPlan,
    planSource: 'partner',
  };
};

// --- Partner fleets (B4) -----------------------------------------------------

/**
 * Who hears about an episode on a partner phone nobody has linked yet. A
 * suspended partner still hears: suspension stops new business, not alerts
 * about phones already in the field.
 */
export const alertRecipientsFor = async (
  partnerId: Types.ObjectId,
): Promise<{
  partner: PartnerSummary;
  recipients: AlertRecipient[];
} | null> => {
  const partner = await Partner.findById(partnerId);
  if (!partner) return null;
  return { partner: toSummary(partner), recipients: partner.alertRecipients };
};

/**
 * The plan an ownerless partner phone is advised under: the one its owner
 * will receive at signup, so the device's capture cadence does not change
 * the moment someone links it.
 */
export const fleetPlan = async (
  partnerId: Types.ObjectId | undefined,
): Promise<UserPlan> => {
  if (!partnerId) return 'free';
  const partner = await Partner.findById(partnerId).select('defaultPlan');
  return partner?.defaultPlan ?? 'free';
};

/** A partner that may still take new enrolments (and so new claims). */
export const isActive = async (partnerId: Types.ObjectId): Promise<boolean> =>
  (await Partner.exists({ _id: partnerId, status: 'active' })) !== null;
