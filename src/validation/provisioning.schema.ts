import { z } from 'zod';
import { deviceName, imei, shortText } from './device.schema';

/**
 * Device-first enrolment (B4): a partner provisions handsets in bulk, each
 * phone claims its own ingest token, and a person links it later.
 */

const provisionRow = z.object({
  imeis: z.array(imei).min(1, 'At least one IMEI is required.').max(2),
  serial: z.string().trim().min(1).max(64).optional(),
  make: shortText,
  deviceModel: shortText,
  /** What the phone is called until its owner renames it. */
  name: deviceName.optional(),
});

/** At most 500 handsets per call: one production lot, one response. */
export const provisionSchema = z.object({
  devices: z
    .array(provisionRow)
    .min(1)
    .max(500, 'At most 500 devices per call.')
    .refine((rows) => {
      // one handset per row: a repeated IMEI is a factory-sheet mistake, and
      // the second row would silently reissue the first row's token
      const all = rows.flatMap((row) => row.imeis);
      return new Set(all).size === all.length;
    }, 'An IMEI appears more than once in this call.'),
});

export const claimSchema = z.object({
  provisioningToken: z.string().trim().min(16).max(200),
  /**
   * A random id the app generates once per install and keeps. A claim whose
   * response was lost may be retried with the same id; no other install can
   * claim the phone.
   */
  installId: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9._-]{16,128}$/,
      'installId is 16-128 letters, digits, dots, hyphens or underscores.',
    ),
  /** Play Integrity token; required when the server enforces integrity. */
  integrityToken: z.string().trim().min(1).max(20_000).optional(),
});

export const linkSchema = z.object({
  /** Rename the phone as the owner links it. */
  name: deviceName.optional(),
});

export type ProvisionInput = z.infer<typeof provisionSchema>;
export type ProvisionRow = z.infer<typeof provisionRow>;
export type ClaimInput = z.infer<typeof claimSchema>;
export type LinkInput = z.infer<typeof linkSchema>;
