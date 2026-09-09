import { z } from 'zod';
import { LEGAL_DOCS } from '../models/legalAcceptance.model';

/**
 * `scrolledToEnd` is a literal `true`: the endpoint refuses an acceptance the
 * client itself says was not scroll-gated. The app must keep the accept button
 * disabled until the user reaches the bottom of the document (see
 * docs/legal-api.md), so a `false` here is a client bug, not a user choice.
 */
export const legalAcceptSchema = z.object({
  doc: z.enum(LEGAL_DOCS),
  /** The version the user was shown - MUST match the server's current one. */
  version: z.string().trim().min(1).max(64),
  scrolledToEnd: z.literal(true, {
    message: 'Acceptance requires the document to be scrolled to the end.',
  }),
});

export type LegalAcceptInput = z.infer<typeof legalAcceptSchema>;
