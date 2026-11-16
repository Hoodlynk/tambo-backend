import { z } from 'zod';
import { partnerCode } from './partner.schema';

/**
 * IMEIs are owner-entered (Android 10+ blocks reading them), so validate shape
 * without being pedantic: 14-16 digits covers IMEI and IMEISV as printed on
 * boxes and in dialers. No Luhn check - a typo'd but plausible IMEI is the
 * owner's to correct, and rejecting real-world variants costs more than it saves.
 */
export const imei = z
  .string()
  .trim()
  .regex(/^\d{14,16}$/, 'An IMEI is 14-16 digits.');

export const deviceName = z.string().trim().min(1, 'Name is required.').max(80);
export const shortText = z.string().trim().min(1).max(80);

const deviceFields = z.object({
  /** What the owner calls it: "My Tecno", "Mum's phone". */
  name: deviceName,
  imeis: z.array(imei).min(1, 'At least one IMEI is required.').max(2),
  make: shortText,
  deviceModel: shortText,
  colour: shortText.optional(),
  purchaseInfo: z.string().trim().min(1).max(500).optional(),
  failedUnlockThreshold: z.number().int().min(1).max(10).optional(),
});

export const deviceSchema = deviceFields.extend({
  /**
   * The partner fleet this phone joins. Defaults to the owner's own partner;
   * fixed at enrolment, so it is not part of the update shape.
   */
  partnerCode: partnerCode.optional(),
});

export const deviceUpdateSchema = deviceFields
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

export const episodeIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid episode id.'),
});

export const episodeListQuerySchema = z.object({
  deviceId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, 'Invalid device id.')
    .optional(),
});

export type DeviceInput = z.infer<typeof deviceSchema>;
export type DeviceUpdateInput = z.infer<typeof deviceUpdateSchema>;
