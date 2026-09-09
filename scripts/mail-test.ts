/**
 * Sends one test email through the CONFIGURED mail driver and waits for the
 * verdict - unlike the app's fire-and-forget sends, a failure prints here.
 *
 * This exists because OTP/alert mail failures are invisible by design at the
 * API surface (see docs/otp-mail-runbook.md): the endpoint succeeds, the send
 * fails later in the background. Run this against the SAME env as the deployed
 * process to prove the mail leg works:
 *
 *   MAIL_DRIVER=resend RESEND_API_KEY=re_... MAIL_FROM="Tambo <no-reply@yourdomain>" \
 *     npm run mail:test -- you@example.com
 */
import config from '../src/config/config';
import { mailer } from '../src/services/mailer';

const main = async (): Promise<void> => {
  const to = process.argv[2];
  if (!to) {
    console.error('Usage: npm run mail:test -- recipient@example.com');
    process.exit(1);
  }

  console.log(`Driver: ${config.mail.driver}`);
  console.log(`From:   ${config.mail.from}`);
  console.log(`To:     ${to}`);

  if (config.mail.driver !== 'resend') {
    console.warn(
      'NOTE: this driver does not deliver real email. Set MAIL_DRIVER=resend ' +
        '(and RESEND_API_KEY, MAIL_FROM) to test actual delivery.',
    );
  }

  try {
    await mailer.send({
      to,
      subject: 'Tambo mail delivery test',
      text:
        'This is a test email from the Tambo backend.\n\n' +
        `Driver: ${config.mail.driver}\nSent at: ${new Date().toISOString()}`,
    });
    console.log('OK - the provider accepted the send.');
  } catch (error) {
    console.error('FAILED - the provider rejected the send:');
    console.error(error);
    console.error(
      '\nCommon causes: RESEND_API_KEY wrong/absent; the Resend account is in ' +
        'onboarding mode (unverified domain: `from` must be onboarding@resend.dev ' +
        "and it can ONLY deliver to the Resend account owner's address); " +
        'MAIL_FROM not on a verified domain. See docs/otp-mail-runbook.md.',
    );
    process.exit(1);
  }
};

void main();
