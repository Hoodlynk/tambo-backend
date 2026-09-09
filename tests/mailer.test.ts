import config from '../src/config/config';
import { resendMailer } from '../src/services/mailer/resend.mailer';

/**
 * The Resend driver is one fetch - but it is the exact leg that failed in the
 * "OTP is down" incident, so pin its behaviour: the request it makes, and that
 * a provider rejection surfaces as a THROWN error (the callers' fire-and-forget
 * logging depends on it) instead of being swallowed.
 */
describe('resendMailer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const message = {
    to: 'owner@example.com',
    subject: 'Test',
    text: 'Body',
  };

  it('POSTs the message to the Resend API with the configured from', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await resendMailer.send(message);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({
      from: config.mail.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  });

  it('throws with status and provider detail when the send is rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        '{"message":"You can only send testing emails to your own email address"}',
    }) as unknown as typeof fetch;

    await expect(resendMailer.send(message)).rejects.toThrow(
      /Resend rejected the send \(403\).*own email address/,
    );
  });
});
