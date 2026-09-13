import type { Pusher, PushMessage, PushResult } from './push.interface';

/** Development driver: prints the notification instead of delivering it. */
class ConsolePusher implements Pusher {
  async send(message: PushMessage): Promise<PushResult> {
    console.log(
      [
        '--- PUSH (console driver) ---',
        `tokens: ${message.tokens.length}`,
        `title:  ${message.title}`,
        `body:   ${message.body}`,
        ...(message.data ? [`data:   ${JSON.stringify(message.data)}`] : []),
        '-----------------------------',
      ].join('\n'),
    );
    return { invalidTokens: [] };
  }
}

export const consolePusher = new ConsolePusher();
