// What the plugin's routes send and take, shared with its web part.

export interface HostInput {
  readonly host: string;
  readonly label: string;
  // An OAuth app on the host, for a Connect button instead of a token.
  readonly clientId: string;
  // Never sent back. Empty keeps the current one, and null takes it away.
  readonly clientSecret: string | null;
}

export interface HostView extends Omit<HostInput, "clientSecret"> {
  readonly hasClientSecret: boolean;
  // The environment variable the secret comes from, when the config file
  // names one instead of holding it sealed (ADR 0039).
  readonly clientSecretEnv: string | null;
}

export interface Connection {
  readonly host: string;
  readonly login: string;
  readonly connectedAt: string;
}

export interface Account {
  readonly admin: boolean;
  readonly hosts: readonly {
    readonly host: string;
    readonly label: string;
    readonly oauth: boolean;
  }[];
  readonly connections: readonly Connection[];
}

// A watched pull request as its row on the Changes card shows it (ADR 0051).
export interface PullWatch {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed" | "merged";
  readonly checks: {
    readonly passed: number;
    readonly failed: number;
    readonly pending: number;
  };
  // null while the host still works it out.
  readonly conflicts: boolean | null;
  readonly changesRequested: boolean;
  readonly autoFix: boolean;
  // Why the last poll failed, such as a host the person disconnected.
  readonly error: string | null;
}

export interface Preferences {
  readonly autoFix: boolean;
  readonly reply: boolean;
}
