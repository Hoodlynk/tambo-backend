import { z } from 'zod';
import config from '../config/config';
import { ENVELOPE_TYPES } from '../models/evidenceEnvelope.model';

/**
 * The envelope contract with the device (Evidence doc S1.1). `payload` is the
 * EXACT string the device serialized - the hash is computed over those bytes,
 * so the server never re-canonicalizes JSON (two "equivalent" JSON strings are
 * different evidence).
 */
const envelope = z.object({
  /** Client-generated (UUID on the device); the upload idempotency key. */
  id: z
    .string()
    .trim()
    .regex(/^[\w-]{8,64}$/, 'Envelope id must be 8-64 url-safe characters.'),
  type: z.enum(ENVELOPE_TYPES),
  capturedAt: z
    .string()
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      'capturedAt must be an ISO 8601 date.',
    ),
  payload: z.string().min(1).max(config.evidence.maxPayloadChars),
  sha256: z
    .string()
    .regex(/^[a-f\d]{64}$/i, 'sha256 must be 64 hex characters.'),
});

export const ingestSchema = z.object({
  envelopes: z
    .array(envelope)
    .min(1, 'Send at least one envelope.')
    .max(
      config.evidence.maxBatch,
      `At most ${config.evidence.maxBatch} envelopes per batch.`,
    ),
});

export const mediaParamsSchema = z.object({
  envelopeId: z.string().regex(/^[\w-]{8,64}$/, 'Invalid envelope id.'),
});

/** The owner's read of one snapshot frame: episode id plus the frame's envelope id. */
export const snapshotMediaParamsSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid episode id.'),
  envelopeId: z.string().regex(/^[\w-]{8,64}$/, 'Invalid envelope id.'),
});

export type EnvelopeInput = z.infer<typeof envelope>;
export type IngestInput = z.infer<typeof ingestSchema>;
