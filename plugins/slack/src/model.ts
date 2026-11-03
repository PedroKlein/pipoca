// What the plugin's routes send, shared with its web part.

export interface BotView {
  readonly name: string;
  // The workspace the bot is in, and who it posts as.
  readonly team: string;
  readonly botUser: string;
  readonly connected: boolean;
  // Why the bot's connection to Slack fails.
  readonly error: string | null;
}

export interface Account {
  readonly admin: boolean;
}
