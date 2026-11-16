import type { Request, Response } from 'express';
import * as pushTokenService from '../services/pushToken.service';
import { authContext } from '../middlewares/auth.middleware';
import { deviceContext } from '../middlewares/deviceAuth.middleware';
import type {
  PushTokenRegisterInput,
  PushTokenUnregisterInput,
} from '../validation/pushToken.schema';

export const register = async (req: Request, res: Response): Promise<void> => {
  const { token, platform } = req.body as PushTokenRegisterInput;
  const row = await pushTokenService.register(authContext(req).userId, {
    token,
    platform,
    userAgent: req.get('user-agent'),
  });
  res.status(200).json({
    pushToken: { platform: row.platform, lastSeenAt: row.lastSeenAt },
  });
};

/** The protected phone registering itself (X-Device-Token), B2. */
export const registerForDevice = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { token, platform } = req.body as PushTokenRegisterInput;
  const row = await pushTokenService.registerForDevice(deviceContext(req), {
    token,
    platform,
    userAgent: req.get('user-agent'),
  });
  res.status(200).json({
    pushToken: { platform: row.platform, lastSeenAt: row.lastSeenAt },
  });
};

export const unregister = async (
  req: Request,
  res: Response,
): Promise<void> => {
  const { token } = req.body as PushTokenUnregisterInput;
  await pushTokenService.unregister(authContext(req).userId, token);
  res.status(204).send();
};
