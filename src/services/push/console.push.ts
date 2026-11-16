import type {
  DataPushMessage,
  Pusher,
  PushMessage,
  PushResult,
} from './push.interface';

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

  async sendData(message: DataPushMessage): Promise<PushResult> {
    console.log(
      [
        '--- DATA PUSH (console driver) ---',
        `tokens: ${message.tokens.length}`,
        `data:   ${JSON.stringify(message.data)}`,
        '----------------------------------',
      ].join('\n'),
    );
    return { invalidTokens: [] };
  }
}

export const consolePusher = new ConsolePusher();
