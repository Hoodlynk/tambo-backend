import type { Request, Response } from 'express';
import type { IDeviceCommand } from '../models/deviceCommand.model';
import * as deviceCommandService from '../services/deviceCommand.service';
import { authContext } from '../middlewares/auth.middleware';
import { deviceContext } from '../middlewares/deviceAuth.middleware';
import type { CommandCreateInput } from '../validation/command.schema';

/** The owner's view: the device's view plus where the command got to. */
const ownerView = (command: IDeviceCommand) => ({
  ...deviceCommandService.toDeviceView(command),
  deviceId: command.device.toString(),
  episodeId: command.episode.toString(),
  status: deviceCommandService.presentStatus(command),
  resultCount: command.resultCount,
  ...(command.deliveredAt
    ? { deliveredAt: command.deliveredAt.toISOString() }
    : {}),
  ...(command.completedAt
    ? { completedAt: command.completedAt.toISOString() }
    : {}),
  ...(command.failedAt ? { failedAt: command.failedAt.toISOString() } : {}),
  ...(command.failureReason ? { failureReason: command.failureReason } : {}),
  ...(command.cancelledAt
    ? { cancelledAt: command.cancelledAt.toISOString() }
    : {}),
});

export const create = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const { command, created } = await deviceCommandService.create(
    authContext(req).userId,
    id,
    req.body as CommandCreateInput,
  );
  // 201 when this call issued it; 200 when converging on an outstanding one
  res.status(created ? 201 : 200).json({ command: ownerView(command) });
};

export const list = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params as { id: string };
  const commands = await deviceCommandService.listForDevice(
    authContext(req).userId,
    id,
  );
  res.status(200).json({ commands: commands.map(ownerView) });
};

export const cancel = async (req: Request, res: Response): Promise<void> => {
  const { id, commandId } = req.params as { id: string; commandId: string };
  const command = await deviceCommandService.cancel(
    authContext(req).userId,
    id,
    commandId,
  );
  res.status(200).json({ command: ownerView(command) });
};

/** The device's poll (X-Device-Token). */
export const poll = async (req: Request, res: Response): Promise<void> => {
  const commands = await deviceCommandService.deliverOutstanding(
    deviceContext(req)._id,
  );
  res
    .status(200)
    .json({ commands: commands.map(deviceCommandService.toDeviceView) });
};
