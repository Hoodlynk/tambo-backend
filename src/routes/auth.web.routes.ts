import { Router } from 'express';
import cookieParser from 'cookie-parser';
import * as authWebController from '../controllers/auth.web.controller';
import { csrfGuard } from '../middlewares/csrf.middleware';
import { rateLimit, bodyField } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { loginSchema, otpVerifySchema } from '../validation/auth.schema';
import { asyncHandler } from '../utils/asyncHandler';

/**
 * The browser (PWA) session surface: the refresh token lives in an httpOnly
 * cookie (path-scoped to this mount), so page scripts can never exfiltrate it.
 * Register, forgot- and reset-password are cookie-irrelevant and shared with
 * /api/auth. Every route here consumes or sets the cookie, so every route
 * carries the CSRF guard; the cookie parser is mounted here, not app-wide -
 * no other surface reads cookies.
 *
 * Request schemas are the SAME objects the mobile routes validate with, and
 * the same rate-limit budgets apply (shared counters: an attacker cannot
 * double their brute-force budget by alternating surfaces).
 */
const router = Router();

router.use(cookieParser());
router.use(csrfGuard);

router.post(
  '/login',
  validate({ body: loginSchema }),
  rateLimit({ name: 'login', subject: bodyField('email') }),
  asyncHandler(authWebController.login),
);

router.post(
  '/otp/verify',
  validate({ body: otpVerifySchema }),
  rateLimit({ name: 'otpVerify' }),
  asyncHandler(authWebController.verifyOtp),
);

// no body: the cookie IS the credential
router.post(
  '/refresh',
  rateLimit({ name: 'refresh' }),
  asyncHandler(authWebController.refresh),
);

router.post('/logout', asyncHandler(authWebController.logout));

export default router;
