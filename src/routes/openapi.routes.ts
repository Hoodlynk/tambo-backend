import { Router } from 'express';
import { openApiDocument } from '../openapi/generate';

const router = Router();

/**
 * The machine-readable contract, generated from the same zod schemas the
 * server validates with - so it cannot drift from actual behaviour. Client
 * teams generate typed clients from this (see docs/client-generation.md).
 */
router.get('/', (_req, res) => {
  res.status(200).json(openApiDocument());
});

export default router;
