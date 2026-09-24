import type { Request, Response } from 'express';
import * as watchdogService from '../services/watchdog.service';

/**
 * The browser side of the quiet alert's one-tap link. Deliberately two steps:
 * GET only renders a confirmation page and never changes anything, because
 * mail scanners and link previewers pre-fetch every URL in an email - a GET
 * that marked the phone stolen would fire on delivery. The POST does the act.
 *
 * Pages always answer 200 (even for a dead link): this API's error responses
 * are JSON envelopes, and a human in a browser needs a readable page. No
 * scripts, inline styles only, and a same-origin form - all inside helmet's
 * default CSP.
 */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} - Tambo</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e8eaed;
         margin: 0; padding: 32px 16px; }
  main { max-width: 440px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  p { line-height: 1.5; color: #b8bcc4; }
  button { width: 100%; padding: 14px; font-size: 16px; font-weight: 600;
           border: 0; border-radius: 10px; background: #e5484d; color: #fff;
           cursor: pointer; margin-top: 12px; }
  .muted { font-size: 14px; color: #8a8f98; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;

const deadLinkPage = (): string =>
  page(
    'Link expired',
    `<h1>This link has expired or was already used</h1>
     <p>If your phone is missing, sign in to Tambo on another phone and mark
     it stolen, or ask one of your buddies to report it from their Tambo app.</p>`,
  );

export const show = async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params as { token: string };
  const target = await watchdogService.describeActionLink(token);

  res.type('html');
  if (!target) {
    res.status(200).send(deadLinkPage());
    return;
  }

  const lastSeen = target.lastSeenAt
    ? `It last checked in at ${escapeHtml(target.lastSeenAt.toISOString())} (UTC).`
    : '';

  res.status(200).send(
    page(
      'Is your phone missing?',
      `<h1>Is &ldquo;${escapeHtml(target.deviceName)}&rdquo; missing?</h1>
       <p>${lastSeen}</p>
       <p>Marking it stolen alerts your Tambo buddies and starts your
       evidence pack for the police and your insurer.</p>
       <form method="post">
         <button type="submit">Yes, mark it stolen</button>
       </form>
       <p class="muted">If your phone is with you, close this page and unlock
       it. Nothing has been changed.</p>`,
    ),
  );
};

export const confirm = async (req: Request, res: Response): Promise<void> => {
  const { token } = req.params as { token: string };
  const result = await watchdogService.useActionLink(token);

  res.type('html');
  if (!result) {
    res.status(200).send(deadLinkPage());
    return;
  }

  res.status(200).send(
    page(
      'Marked as stolen',
      result.created
        ? `<h1>Your phone is marked as stolen</h1>
           <p>Your buddies have been alerted by email, and your evidence pack
           is being assembled. Block your SIM with your operator and report at
           the nearest police station to get an OB number.</p>`
        : `<h1>Your phone was already marked as stolen</h1>
           <p>Your buddies were alerted when that happened. Block your SIM with
           your operator and report at the nearest police station.</p>`,
    ),
  );
};
