import { Router } from 'express';
import * as authController from '../controllers/auth.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { bodyField, rateLimit } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import {
  changeEmailSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  otpResendSchema,
  otpVerifySchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sessionIdSchema,
} from '../validation/auth.schema';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * Middleware order is deliberate: `validate` runs BEFORE `rateLimit` so the
 * limiter keys on the normalized email ("A@x.com" and "a@x.com" share one
 * budget). The cost is that malformed requests do not consume budget, which is
 * fine - a malformed request never attempts authentication.
 */

// --- Public: credential exchange -------------------------------------------
router.post(
  '/register',
  validate({ body: registerSchema }),
  rateLimit({ name: 'register' }),
  asyncHandler(authController.register),
);

router.post(
  '/login',
  validate({ body: loginSchema }),
  rateLimit({ name: 'login', subject: bodyField('email') }),
  asyncHandler(authController.login),
);

// --- Public: OTP completion (register/login/change flows all land here) -----
router.post(
  '/otp/verify',
  validate({ body: otpVerifySchema }),
  rateLimit({ name: 'otpVerify' }),
  asyncHandler(authController.verifyOtp),
);

router.post(
  '/otp/resend',
  validate({ body: otpResendSchema }),
  rateLimit({ name: 'otpResend' }),
  asyncHandler(authController.resendOtp),
);

// --- Public: session lifecycle ---------------------------------------------
router.post(
  '/refresh',
  validate({ body: refreshSchema }),
  rateLimit({ name: 'refresh' }),
  asyncHandler(authController.refresh),
);

router.post(
  '/logout',
  validate({ body: logoutSchema }),
  asyncHandler(authController.logout),
);

// --- Public: password recovery ---------------------------------------------
router.post(
  '/forgot-password',
  validate({ body: forgotPasswordSchema }),
  rateLimit({ name: 'forgotPassword', subject: bodyField('email') }),
  asyncHandler(authController.forgotPassword),
);

router.post(
  '/reset-password',
  validate({ body: resetPasswordSchema }),
  rateLimit({ name: 'resetPassword' }),
  asyncHandler(authController.resetPassword),
);

// --- Authenticated ---------------------------------------------------------
router.get('/me', requireAuth, asyncHandler(authController.me));

router.post(
  '/change-password',
  requireAuth,
  validate({ body: changePasswordSchema }),
  asyncHandler(authController.changePassword),
);

router.post(
  '/change-email',
  requireAuth,
  validate({ body: changeEmailSchema }),
  asyncHandler(authController.changeEmail),
);

router.post(
  '/verify-email',
  requireAuth,
  rateLimit({ name: 'verifyEmail' }),
  asyncHandler(authController.requestEmailVerification),
);

router.post('/logout-all', requireAuth, asyncHandler(authController.logoutAll));

router.get('/sessions', requireAuth, asyncHandler(authController.listSessions));

router.delete(
  '/sessions/:id',
  requireAuth,
  validate({ params: sessionIdSchema }),
  asyncHandler(authController.revokeSession),
);

export default router;
