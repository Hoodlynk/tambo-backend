import { z } from 'zod';
import { partnerCode } from './partner.schema';

/**
 * bcrypt silently ignores BYTES past 72, so two different passwords sharing
 * their first 72 bytes would authenticate the same account. The cap must
 * therefore be 72 bytes (not a character count - multibyte UTF-8 characters
 * consume more than one byte each), which genuinely makes aliasing impossible.
 */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
    message: 'Password must be at most 72 bytes.',
  });

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address.'))
  .describe('Normalized to lowercase; uniqueness is case-insensitive.');

const name = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(120, 'Name must be at most 120 characters.');

/** Opaque refresh/reset tokens: hex strings we issued. */
const opaqueToken = z.string().trim().min(1, 'Token is required.');

export const registerSchema = z.object({
  name,
  email,
  password,
  /** A white-label build passes its partner's code (B3). */
  partnerCode: partnerCode.optional(),
});
export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required.'),
});
export const refreshSchema = z.object({ refreshToken: opaqueToken });
export const logoutSchema = z.object({ refreshToken: opaqueToken });

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: password,
});

export const forgotPasswordSchema = z.object({ email });
export const resetPasswordSchema = z.object({ token: opaqueToken, password });

export const changeEmailSchema = z.object({
  newEmail: email,
  password: z.string().min(1, 'Password is required.'),
});

export const otpVerifySchema = z.object({
  challengeId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid challenge id.'),
  code: z.string().regex(/^\d{6}$/, 'The code is 6 digits.'),
});

export const otpResendSchema = z.object({
  challengeId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid challenge id.'),
});

export const sessionIdSchema = z.object({
  id: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid session id.'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type ChangeEmailInput = z.infer<typeof changeEmailSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
