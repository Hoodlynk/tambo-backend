import { z } from 'zod';

/**
 * IMEIs are owner-entered (Android 10+ blocks reading them), so validate shape
 * without being pedantic: 14-16 digits covers IMEI and IMEISV as printed on
 * boxes and in dialers. No Luhn check - a typo'd but plausible IMEI is the
 * owner's to correct, and rejecting real-world variants costs more than it saves.
 */
const imei = z
  .string()
  .trim()
  .regex(/^\d{14,16}$/, 'An IMEI is 14-16 digits.');

const name = z.string().trim().min(1, 'Name is required.').max(80);
const shortText = z.string().trim().min(1).max(80);

const installId = z
  .string()
  .trim()
  .regex(/^[\w-]{8,64}$/, 'installId must be 8-64 url-safe characters.');

export const deviceSchema = z.object({
  /** What the owner calls it: "My Tecno", "Mum's phone". */
  name,
  /**
   * Optional at enrolment - the app enrols itself at sign-in and the owner
   * adds IMEIs later - but a list that IS sent must hold at least one.
   */
  imeis: z
    .array(imei)
    .min(1, 'At least one IMEI is required.')
    .max(2)
    .optional(),
  make: shortText,
  deviceModel: shortText,
  colour: shortText.optional(),
  purchaseInfo: z.string().trim().min(1).max(500).optional(),
  failedUnlockThreshold: z.number().int().min(1).max(10).optional(),
});

/** Enrolment adds the install id; it is not something an update may change. */
export const deviceEnrolSchema = deviceSchema.extend({
  installId: installId.optional(),
});

export const deviceUpdateSchema = deviceSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to update.',
  );

export const deviceIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid device id.'),
});

export const markStolenSchema = z.object({
  note: z.string().trim().min(1).max(1000).optional(),
});

/** generateOpaqueToken(): 48 random bytes as hex. */
export const alertActionTokenSchema = z.object({
  token: z.string().regex(/^[a-f\d]{96}$/, 'Invalid link.'),
});

export const episodeIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid episode id.'),
});

export const episodeListQuerySchema = z.object({
  deviceId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, 'Invalid device id.')
    .optional(),
});

export type DeviceInput = z.infer<typeof deviceEnrolSchema>;
export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;
