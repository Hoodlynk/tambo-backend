import { z } from 'zod';

const label = z.string().trim().min(1, 'Label is required.').max(40);
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
// floor keeps the radius meaningful against GPS noise; cap keeps "familiar"
// meaning a place, not a whole town
const radiusM = z.number().int().min(50).max(2000);

export const familiarLocationSchema = z.object({
  label,
  lat,
  lng,
  radiusM: radiusM.optional(),
});

export const familiarLocationUpdateSchema = familiarLocationSchema
  .partial()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to update.',
  );

export const familiarLocationIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid familiar location id.'),
});

export type FamiliarLocationInput = z.infer<typeof familiarLocationSchema>;
export type FamiliarLocationUpdateInput = z.infer<
  typeof familiarLocationUpdateSchema
>;
