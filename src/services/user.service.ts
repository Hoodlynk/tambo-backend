import User from '../models/user.model';
import type { IUser } from '../models/user.model';
import { AppError } from '../utils/appError';

export const getById = async (userId: string): Promise<IUser> => {
  const user = await User.findById(userId);
  if (!user) throw AppError.notFound('User not found.', 'user_not_found');
  return user;
};

/**
 * Clears the failed-login lockout. Called wherever the account owner has just
 * proven control by a stronger factor than the password an attacker was
 * guessing: a successful password login, a reset link, or an emailed OTP.
 */
export const clearLockout = async (userId: string): Promise<void> => {
  await User.updateOne(
    { _id: userId },
    { $set: { failedLoginAttempts: 0 }, $unset: { lockedUntil: 1 } },
  );
};
