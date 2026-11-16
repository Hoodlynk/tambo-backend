import type { Types } from 'mongoose';
import { commandPolicy } from '../config/commands';
import DeviceCommand from '../models/deviceCommand.model';
import type {
  CommandType,
  IDeviceCommand,
  PresentedCommandStatus,
} from '../models/deviceCommand.model';
import TheftEpisode from '../models/theftEpisode.model';
import { AppError } from '../utils/appError';
import type { CommandCreateInput } from '../validation/command.schema';
import * as deviceService from './device.service';
import type { CommandRef } from './evidenceCommand';
import * as notifier from './notifier.service';

/**
 * Remote commands (B2, docs/commands-api.md): the owner asks the stolen phone
 * to snapshot, locate, or ring; the phone learns of it on its next poll or
 * ingest reply (an FCM data message makes "next" soon); it answers with
 * ordinary evidence envelopes carrying the command id.
 *
 * TheftEpisode is read directly rather than through episode.service, which
 * calls back into this module when an episode resolves - same acyclic-import
 * reasoning as snapshot.service and trail.service.
 */

const OUTSTANDING = ['pending', 'delivered'] as const;

/** Still worth handing to the device: not answered, cancelled, or stale. */
const outstandingFilter = (now: Date) => ({
  status: { $in: [...OUTSTANDING] },
  expiresAt: { $gt: now },
});

/** The status the API reports; "expired" is derived from the clock, never stored. */
export const presentStatus = (
  command: Pick<IDeviceCommand, 'status' | 'expiresAt'>,
  now = new Date(),
): PresentedCommandStatus =>
  (OUTSTANDING as readonly string[]).includes(command.status) &&
  command.expiresAt <= now
    ? 'expired'
    : command.status;

/** What the phone is told: enough to act, nothing about the owner's view. */
export interface DeviceCommandView {
  id: string;
  type: CommandType;
  params: { cameras?: string[]; durationSeconds?: number };
  issuedAt: string;
  expiresAt: string;
}

export const toDeviceView = (command: IDeviceCommand): DeviceCommandView => ({
  id: command._id.toString(),
  type: command.type,
  params: {
    ...(command.params?.cameras?.length
      ? { cameras: [...command.params.cameras] }
      : {}),
    ...(command.params?.durationSeconds !== undefined
      ? { durationSeconds: command.params.durationSeconds }
      : {}),
  },
  issuedAt: command.createdAt.toISOString(),
  expiresAt: command.expiresAt.toISOString(),
});

const paramsFor = (input: CommandCreateInput): IDeviceCommand['params'] => {
  switch (input.type) {
    case 'snapshot':
      return { cameras: input.cameras ?? ['front', 'back'] };
    case 'ring':
      return {
        durationSeconds:
          input.durationSeconds ?? commandPolicy.ring.defaultSeconds,
      };
    case 'locate':
      return {};
  }
};

/**
 * Wakes the phone so it polls now rather than at its next trail tick. The
 * payload names the command but carries no parameters: the poll, which is
 * authenticated with the device's own token, is the authoritative channel.
 */
const wake = (command: IDeviceCommand): void => {
  notifier.wakeDevice(command.device.toString(), {
    type: 'device_command',
    commandId: command._id.toString(),
    commandType: command.type,
  });
};

/**
 * Issues a command, or converges on the outstanding one of the same type -
 * an owner tapping "Ring" three times in a panic means one ring, not three.
 * Converging re-sends the wake-up (the phone may have slept through the
 * first) but keeps the original command's parameters and lifetime.
 */
export const create = async (
  userId: string,
  deviceId: string,
  input: CommandCreateInput,
): Promise<{ command: IDeviceCommand; created: boolean }> => {
  const device = await deviceService.getOwned(userId, deviceId);

  // commands exist for an incident, never as a standing way to watch a phone
  // (or whoever is holding it) outside one
  const episode = await TheftEpisode.findOne({
    device: device._id,
    status: 'open',
  }).select('_id');
  if (!episode) {
    throw AppError.conflict(
      'Commands can only be sent while the device is marked stolen.',
      'episode_not_open',
    );
  }

  // without an ingest token the phone can never poll: a command would sit
  // pending until it expired while the owner watched a spinner
  if (!(await deviceService.hasIngestToken(device._id))) {
    throw AppError.conflict(
      "This device's upload token was revoked, so it cannot receive commands.",
      'device_token_revoked',
    );
  }

  const now = new Date();
  const existing = await DeviceCommand.findOne({
    device: device._id,
    type: input.type,
    ...outstandingFilter(now),
  }).sort({ createdAt: -1 });
  if (existing) {
    wake(existing);
    return { command: existing, created: false };
  }

  const command = await DeviceCommand.create({
    user: device.user,
    device: device._id,
    episode: episode._id,
    type: input.type,
    params: paramsFor(input),
    // one instant for both, so issuedAt + lifetime is exactly expiresAt
    createdAt: now,
    expiresAt: new Date(
      now.getTime() + commandPolicy.ttlSeconds[input.type] * 1000,
    ),
  });
  wake(command);
  return { command, created: true };
};

/** The owner's view of a device's commands, newest first. */
export const listForDevice = async (
  userId: string,
  deviceId: string,
): Promise<IDeviceCommand[]> => {
  const device = await deviceService.getOwned(userId, deviceId);
  return DeviceCommand.find({ device: device._id })
    .sort({ createdAt: -1 })
    .limit(commandPolicy.listLimit)
    .exec();
};

/**
 * Cancels an outstanding command. Idempotent: cancelling one that already
 * finished (or was already cancelled) returns it unchanged - the owner wanted
 * it to stop, and it has.
 */
export const cancel = async (
  userId: string,
  deviceId: string,
  commandId: string,
): Promise<IDeviceCommand> => {
  const device = await deviceService.getOwned(userId, deviceId);
  const cancelled = await DeviceCommand.findOneAndUpdate(
    { _id: commandId, device: device._id, status: { $in: [...OUTSTANDING] } },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
    { new: true },
  );
  if (cancelled) return cancelled;

  const command = await DeviceCommand.findOne({
    _id: commandId,
    device: device._id,
  });
  if (!command) {
    throw AppError.notFound('Command not found.', 'command_not_found');
  }
  return command;
};

/**
 * Hands the device everything outstanding, oldest first, and marks the
 * never-before-seen ones delivered. Delivered commands keep being handed
 * over until answered: a reply lost on a flaky network must not lose the
 * command with it, and the device dedups on the id.
 */
export const deliverOutstanding = async (
  deviceId: Types.ObjectId,
): Promise<IDeviceCommand[]> => {
  const now = new Date();
  const commands = await DeviceCommand.find({
    device: deviceId,
    ...outstandingFilter(now),
  })
    .sort({ createdAt: 1 })
    .exec();

  const fresh = commands.filter((command) => command.status === 'pending');
  if (fresh.length > 0) {
    await DeviceCommand.updateMany(
      { _id: { $in: fresh.map((command) => command._id) }, status: 'pending' },
      { $set: { status: 'delivered', deliveredAt: now } },
    );
  }
  return commands;
};

/** How many commands are still waiting on the device (the status card). */
export const countOutstanding = (deviceId: Types.ObjectId): Promise<number> =>
  DeviceCommand.countDocuments({
    device: deviceId,
    ...outstandingFilter(new Date()),
  }).exec();

/**
 * Which of the command ids an ingest batch names really are THIS device's
 * commands. Anything else is ignored: a payload cannot attach evidence to,
 * or complete, another device's command.
 */
export const ownCommandIds = async (
  deviceId: Types.ObjectId,
  commandIds: string[],
): Promise<Set<string>> => {
  if (commandIds.length === 0) return new Set();
  const rows = await DeviceCommand.find({
    _id: { $in: commandIds },
    device: deviceId,
  }).select('_id');
  return new Set(rows.map((row) => row._id.toString()));
};

/**
 * Applies the answers an ingest batch carried. A result completes the
 * command (even past its expiry, or after an earlier failure report - the
 * phone managed it after all); a failure report only fails a command still
 * outstanding. A cancelled command stays cancelled but still counts what
 * arrived, since the evidence itself is kept regardless.
 */
export const recordResults = async (
  deviceId: Types.ObjectId,
  refs: CommandRef[],
): Promise<void> => {
  const byCommand = new Map<string, { done: number; failure?: CommandRef }>();
  for (const ref of refs) {
    const entry = byCommand.get(ref.commandId) ?? { done: 0 };
    if (ref.outcome === 'done') entry.done += 1;
    else entry.failure ??= ref;
    byCommand.set(ref.commandId, entry);
  }

  const now = new Date();
  for (const [commandId, { done, failure }] of byCommand) {
    if (done > 0) {
      await DeviceCommand.updateOne(
        { _id: commandId, device: deviceId },
        { $inc: { resultCount: done } },
      );
      await DeviceCommand.updateOne(
        {
          _id: commandId,
          device: deviceId,
          status: { $in: [...OUTSTANDING, 'failed'] },
        },
        {
          $set: { status: 'completed', completedAt: now },
          $unset: { failedAt: 1, failureReason: 1 },
        },
      );
    } else if (failure) {
      await DeviceCommand.updateOne(
        { _id: commandId, device: deviceId, status: { $in: [...OUTSTANDING] } },
        {
          $set: {
            status: 'failed',
            failedAt: now,
            ...(failure.reason ? { failureReason: failure.reason } : {}),
          },
        },
      );
    }
  }
};

/**
 * Called when an episode resolves: a recovered phone must not ring or start
 * photographing whoever is holding it on the strength of a stale request.
 */
export const cancelForEpisode = async (
  episodeId: Types.ObjectId,
): Promise<void> => {
  await DeviceCommand.updateMany(
    { episode: episodeId, status: { $in: [...OUTSTANDING] } },
    { $set: { status: 'cancelled', cancelledAt: new Date() } },
  );
};
