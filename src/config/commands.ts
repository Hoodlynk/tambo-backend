import type { CommandType } from '../models/deviceCommand.model';

/**
 * Remote-command policy (B2, docs/commands-api.md), kept beside the rate
 * limits so it is reviewable in one place.
 *
 * Lifetimes differ per type because staleness costs differ: a ring that
 * fires twenty minutes late is noise in a thief's pocket, while a snapshot
 * or a fix from a phone that was offline for half an hour is still exactly
 * what the owner asked for.
 */
export const commandPolicy = {
  ttlSeconds: {
    snapshot: 30 * 60,
    locate: 30 * 60,
    ring: 5 * 60,
  } satisfies Record<CommandType, number>,
  ring: { defaultSeconds: 30, minSeconds: 5, maxSeconds: 120 },
  /** How many of a device's commands the owner's list returns, newest first. */
  listLimit: 50,
};
