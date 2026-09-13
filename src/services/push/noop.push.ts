import type { Pusher, PushMessage, PushResult } from './push.interface';

/**
 * Test driver: records what would have been sent, delivers nothing. Tests can
 * also stage invalid tokens to exercise the prune-on-error path.
 */
class NoopPusher implements Pusher {
  public readonly sent: PushMessage[] = [];
  /** Tokens the next send() reports as dead (then clears). */
  public failNext: string[] = [];

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    const invalidTokens = this.failNext.filter((token) =>
      message.tokens.includes(token),
    );
    this.failNext = [];
    return { invalidTokens };
  }

  clear(): void {
    this.sent.length = 0;
    this.failNext = [];
  }
}

export const noopPusher = new NoopPusher();
