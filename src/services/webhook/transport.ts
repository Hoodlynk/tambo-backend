import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import net from 'net';
import config from '../../config/config';

/**
 * Sends one signed webhook. The URL is partner-supplied, so this is an SSRF
 * surface: the address check runs inside the socket's own DNS lookup, on the
 * address actually connected to. Checking the hostname first and connecting
 * afterwards would let a rebinding DNS server answer public, then private.
 */

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** True for any address a partner URL must never reach. */
export const isBlockedAddress = (address: string): boolean => {
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family !== 6) return true;
  // ::ffff:10.0.0.1 is 10.0.0.1 to the kernel
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, 'ipv6');
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

const refused = (hostname: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${hostname} resolves to a non-public address`), {
    code: 'EADDRBLOCKED',
  });

const guardedLookup = (
  hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
): void => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, '');
      return;
    }
    const first = addresses[0];
    if (!first || addresses.some((entry) => isBlockedAddress(entry.address))) {
      callback(refused(hostname), '');
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, first.address, first.family);
  });
};

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, as Stripe does. */
export const signatureHeader = (
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string => {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
};

export interface WebhookRequest {
  url: string;
  secret: string;
  eventId: string;
  type: string;
  body: string;
}

export type WebhookOutcome =
  | { ok: true; statusCode: number }
  | { ok: false; statusCode?: number; error: string };

/** One attempt. Never throws: every failure is an outcome to record. */
export const post = (request: WebhookRequest): Promise<WebhookOutcome> =>
  new Promise((resolve) => {
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      resolve({ ok: false, error: 'invalid_url' });
      return;
    }

    const local = config.webhooks.allowLocalTargets;
    if (target.protocol !== 'https:' && !local) {
      resolve({ ok: false, error: 'https_required' });
      return;
    }
    // an IP literal never goes through the lookup, so it is checked here
    const host = target.hostname.replace(/^\[|\]$/g, '');
    if (!local && net.isIP(host) && isBlockedAddress(host)) {
      resolve({ ok: false, error: 'address_blocked' });
      return;
    }

    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(
      target,
      {
        method: 'POST',
        timeout: config.webhooks.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(request.body),
          'User-Agent': 'Tambo-Webhooks/1',
          'Tambo-Event-Id': request.eventId,
          'Tambo-Event-Type': request.type,
          'Tambo-Signature': signatureHeader(request.secret, request.body),
        },
        ...(local ? {} : { lookup: guardedLookup as never }),
        // a delivery attempt is one request on its own socket
        agent: false,
      },
      (res) => {
        // the answer is the status; the body is the partner's business, and
        // a redirect is a failure (followed, it would dodge the address check)
        res.resume();
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 300) {
          resolve({ ok: true, statusCode });
        } else {
          resolve({ ok: false, statusCode, error: `http_${statusCode}` });
        }
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      resolve({
        ok: false,
        error:
          error.code === 'EADDRBLOCKED'
            ? 'address_blocked'
            : error.message === 'timeout'
              ? 'timeout'
              : (error.code ?? 'network_error'),
      });
    });
    req.end(request.body);
  });
