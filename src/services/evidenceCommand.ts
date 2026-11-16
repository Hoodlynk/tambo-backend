/**
 * Best-effort reading of an envelope payload as the ANSWER to a remote
 * command (B2, docs/commands-api.md). Like evidenceSnapshot.ts this only
 * reads: the payload stays opaque, hashed and stored byte for byte, and a
 * payload that names no command (or names one badly) is ordinary evidence.
 *
 * Contract with the device - any envelope type may carry it:
 *   { "commandId": "<24 hex>", ...the usual payload... }
 *   { "commandId": "<24 hex>", "outcome": "failed", "reason": "camera_unavailable" }
 */

export interface CommandRef {
  commandId: string;
  /** "failed" only when the device says so; anything else is a result. */
  outcome: 'done' | 'failed';
  reason?: string;
}

const COMMAND_ID = /^[a-f\d]{24}$/i;
const REASON = /^[\w-]{1,64}$/;

export const parseCommandRef = (payload: string): CommandRef | null => {
  // most envelopes answer no command; skip the parse for them on the hot path
  if (!payload.includes('"commandId"')) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (
    typeof record.commandId !== 'string' ||
    !COMMAND_ID.test(record.commandId)
  )
    return null;

  const failed = record.outcome === 'failed';
  const reason =
    failed && typeof record.reason === 'string' && REASON.test(record.reason)
      ? record.reason
      : undefined;

  return {
    commandId: record.commandId.toLowerCase(),
    outcome: failed ? 'failed' : 'done',
    ...(reason ? { reason } : {}),
  };
};
