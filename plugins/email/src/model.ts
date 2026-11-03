// What the plugin's routes send, shared with its web part.

export interface MailboxView {
  readonly name: string;
  readonly address: string;
  // Why the last check of its mail failed.
  readonly error: string | null;
}

export interface Account {
  readonly admin: boolean;
}
