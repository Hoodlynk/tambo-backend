import config from '../config/config';
import type { ClientPlatform } from '../config/client';
import type { Types } from 'mongoose';
import type { IPartner, PartnerFeature } from '../models/partner.model';
import { AppError } from '../utils/appError';
import { compareVersions } from '../utils/version';
import * as partnerService from './partner.service';
import type { PartnerSummary } from './partner.service';

/**
 * The launch handshake (GET /client/config): one call at app start tells the
 * client whether it must update, which brand to paint, and which optional
 * features to show. Runtime theming means one binary serves every partner
 * (owner decision W1's default); the build only carries the partner code.
 */

export type UpdateAdvice = 'required' | 'recommended' | 'none' | 'unknown';

export interface ClientConfig {
  platform: ClientPlatform;
  versions: {
    minimum: string;
    recommended: string;
    /** "unknown" when the client did not send X-Client-Version. */
    update: UpdateAdvice;
  };
  partner: PartnerSummary | null;
  brand: {
    displayName: string;
    logoUrl: string | null;
    colors: { primary: string; onPrimary: string };
    supportUrl: string | null;
    supportEmail: string | null;
  };
  features: Record<PartnerFeature, boolean>;
}

/** Tambo's own brand: what an unbranded build paints. */
const TAMBO_BRAND: ClientConfig['brand'] = {
  displayName: 'Tambo',
  logoUrl: null,
  colors: { primary: '#1D28D6', onPrimary: '#FFFFFF' },
  supportUrl: 'https://tambo-app.com',
  supportEmail: null,
};

const ALL_FEATURES: ClientConfig['features'] = {
  buddies: true,
  plans: true,
  familiarLocations: true,
};

const brandOf = (partner: IPartner): ClientConfig['brand'] => ({
  displayName: partner.brand.displayName,
  logoUrl: partner.brand.logoUrl ?? null,
  colors: {
    primary: partner.brand.colors.primary,
    onPrimary: partner.brand.colors.onPrimary,
  },
  supportUrl: partner.brand.supportUrl ?? null,
  supportEmail: partner.brand.supportEmail ?? null,
});

/**
 * The brand a device is painted in: its partner's, or Tambo's. A suspended
 * partner keeps its brand, as on the launch handshake.
 */
export const brandForDevice = async (
  partnerId: Types.ObjectId | undefined,
): Promise<ClientConfig['brand']> => {
  if (!partnerId) return TAMBO_BRAND;
  const partner = await partnerService.findById(partnerId);
  return partner ? brandOf(partner) : TAMBO_BRAND;
};

const adviseUpdate = (
  version: string | undefined,
  policy: { minimum: string; recommended: string },
): UpdateAdvice => {
  if (!version) return 'unknown';
  if (compareVersions(version, policy.minimum) < 0) return 'required';
  if (compareVersions(version, policy.recommended) < 0) return 'recommended';
  return 'none';
};

export const forClient = async (
  platform: ClientPlatform,
  partnerCode: string | undefined,
  clientVersion: string | undefined,
): Promise<ClientConfig> => {
  const policy = config.clientVersions[platform];
  const versions = { ...policy, update: adviseUpdate(clientVersion, policy) };

  if (!partnerCode) {
    return {
      platform,
      versions,
      partner: null,
      brand: TAMBO_BRAND,
      features: ALL_FEATURES,
    };
  }

  // a branded build with a mistyped code should fail loudly in QA, not ship
  // painted as Tambo
  const partner = await partnerService.findByCode(partnerCode);
  if (!partner) {
    throw AppError.notFound(
      'That partner code is not recognised.',
      'unknown_partner',
    );
  }
  return {
    platform,
    versions,
    partner: partnerService.toSummary(partner),
    brand: brandOf(partner),
    features: {
      buddies: partner.features.buddies,
      plans: partner.features.plans,
      familiarLocations: partner.features.familiarLocations,
    },
  };
};
