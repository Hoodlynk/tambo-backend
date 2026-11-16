import { z } from 'zod';
import { commandPolicy } from '../config/commands';
import { COMMAND_CAMERAS, COMMAND_TYPES } from '../models/deviceCommand.model';

const objectId = (label: string) =>
  z.string().regex(/^[a-f\d]{24}$/i, `Invalid ${label} id.`);

/**
 * One flat body for every command type rather than a discriminated union:
 * the generated clients stay a plain object, and a field sent with the wrong
 * type is a named validation error instead of a silent drop.
 */
export const commandCreateSchema = z
  .object({
    type: z.enum(COMMAND_TYPES),
    /** snapshot only; both cameras when absent. */
    cameras: z
      .array(z.enum(COMMAND_CAMERAS))
      .min(1)
      .max(COMMAND_CAMERAS.length)
      .refine(
        (cameras) => new Set(cameras).size === cameras.length,
        'List each camera once.',
      )
      .optional(),
    /** ring only. */
    durationSeconds: z
      .number()
      .int()
      .min(commandPolicy.ring.minSeconds)
      .max(commandPolicy.ring.maxSeconds)
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cameras !== undefined && value.type !== 'snapshot') {
      ctx.addIssue({
        code: 'custom',
        path: ['cameras'],
        message: 'cameras only applies to a snapshot command.',
      });
    }
    if (value.durationSeconds !== undefined && value.type !== 'ring') {
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message: 'durationSeconds only applies to a ring command.',
      });
    }
  });

export const commandParamsSchema = z.object({
  id: objectId('device'),
  commandId: objectId('command'),
});

export type CommandCreateInput = z.infer<typeof commandCreateSchema>;
