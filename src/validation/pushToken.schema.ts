import { z } from 'zod';
import { PUSH_PLATFORMS } from '../models/pushToken.model';

/** FCM registration tokens are opaque; bound the length, not the format. */
const token = z.string().trim().min(20).max(4096);

export const pushTokenRegisterSchema = z.object({
  token,
  platform: z.enum(PUSH_PLATFORMS),
});

export const pushTokenUnregisterSchema = z.object({ token });

export type PushTokenRegisterInput = z.infer<typeof pushTokenRegisterSchema>;
export type PushTokenUnregisterInput = z.infer<typeof pushTokenUnregisterSchema>;
