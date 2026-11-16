import type {
  DataPushMessage,
  Pusher,
  PushMessage,
  PushResult,
} from './push.interface';

/**
 * Test driver: records what would have been sent, delivers nothing. Tests can
 * also stage invalid tokens to exercise the prune-on-error path.
 */
class NoopPusher implements Pusher {
  public readonly sent: PushMessage[] = [];
  /** Silent data messages, kept apart so alert assertions stay exact. */
  public readonly sentData: DataPushMessage[] = [];
  /** Tokens the next send() reports as dead (then clears). */
  public failNext: string[] = [];

  async send(message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return { invalidTokens: this.takeFailures(message.tokens) };
  }

  async sendData(message: DataPushMessage): Promise<PushResult> {
    this.sentData.push(message);
    return { invalidTokens: this.takeFailures(message.tokens) };
  }

  private takeFailures(tokens: string[]): string[] {
    const invalid = this.failNext.filter((token) => tokens.includes(token));
    this.failNext = [];
    return invalid;
  }

  clear(): void {
    this.sent.length = 0;
    this.sentData.length = 0;
    this.failNext = [];
  }
}

export const noopPusher = new NoopPusher();
