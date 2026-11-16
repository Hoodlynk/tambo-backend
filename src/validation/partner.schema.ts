import { z } from 'zod';
import { CLIENT_PLATFORMS } from '../config/client';
import { PARTNER_STATUSES, PARTNER_TYPES } from '../models/partner.model';
import { USER_PLANS } from '../models/user.model';

const objectId = (label: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, `Invalid ${label} id.`);

/**
 * Partner codes are typed by people at signup and baked into branded builds,
 * so they are short, lowercase and unambiguous. Normalized before the check so
 * " Acme " and "ACME" find the same partner.
 */
export const partnerCode = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{1,31}$/,
        'A partner code is 2-32 lowercase letters, digits or hyphens.',
      ),
  );

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Colours are #RRGGBB.')
  .transform((value) => value.toUpperCase());

const httpsUrl = z
  .url({ protocol: /^https$/, message: 'Must be an https URL.' })
  .max(500);

const brandSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  logoUrl: httpsUrl.optional(),
  colors: z.object({ primary: hexColor, onPrimary: hexColor }),
  supportUrl: httpsUrl.optional(),
  supportEmail: z.email().max(254).optional(),
});

const featuresSchema = z
  .object({
    buddies: z.boolean(),
    plans: z.boolean(),
    familiarLocations: z.boolean(),
  })
  .partial();

const alertRecipientsSchema = z
  .array(
    z.object({
      email: z.string().trim().toLowerCase().pipe(z.email()),
      name: z.string().trim().min(1).max(120).optional(),
    }),
  )
  .max(5, 'At most 5 alert recipients.');

export const partnerCreateSchema = z.object({
  code: partnerCode,
  name: z.string().trim().min(1).max(120),
  type: z.enum(PARTNER_TYPES),
  brand: brandSchema,
  features: featuresSchema.optional(),
  defaultPlan: z.enum(USER_PLANS).optional(),
  alertRecipients: alertRecipientsSchema.optional(),
});

// `code` is immutable: branded builds and signups already carry it
export const partnerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(PARTNER_TYPES),
    status: z.enum(PARTNER_STATUSES),
    brand: brandSchema,
    features: featuresSchema,
    defaultPlan: z.enum(USER_PLANS).nullable(),
    alertRecipients: alertRecipientsSchema,
  })
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to update.',
  );

export const partnerIdSchema = z.object({ id: objectId('partner') });
export const partnerKeyParamsSchema = z.object({
  id: objectId('partner'),
  keyId: objectId('key'),
});
export const partnerKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

// --- The launch handshake ----------------------------------------------------

export const clientConfigQuerySchema = z.object({
  platform: z.enum(CLIENT_PLATFORMS),
  partner: partnerCode.optional(),
});

export type PartnerCreateInput = z.infer<typeof partnerCreateSchema>;
export type PartnerUpdateInput = z.infer<typeof partnerUpdateSchema>;
export type ClientConfigQuery = z.infer<typeof clientConfigQuerySchema>;
