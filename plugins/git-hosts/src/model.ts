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
  // How many people connected their account on it.
  readonly connected: number;
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

export interface Identity {
  readonly name: string;
  readonly email: string;
}

// The name and email a person commits as on each host, and by default on
// the others (ADR 0072).
export interface CommitIdentities {
  readonly default: Identity | null;
  readonly hosts: readonly (Identity & { readonly host: string })[];
}

// Where the server and the person are in the plugin's setup steps
// (ADR 0072). Going on without a host is an answer: the admin's for the
// server, and the person's for the hosts listed when they gave it.
export interface SetupState {
  // The deploy's file that sets the hosts, which then only show.
  readonly lockedIn: string | null;
  readonly noHosts: boolean;
  readonly withoutHosts: boolean;
  readonly server: boolean;
  readonly person: boolean;
}

// What a person can commit as on a host they connected: their name there and
// the emails the host verified, the primary first.
export interface HostEmails {
  readonly name: string | null;
  readonly emails: readonly string[];
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

// A watched pull request with its repository, as the team hub lists it.
export interface WatchedPull extends PullWatch {
  readonly repository: string;
}

export interface Preferences {
  readonly autoFix: boolean;
  readonly reply: boolean;
}

// A technical user as Settings shows it to admins (ADR 0060).
export interface TechnicalUserView {
  readonly name: string;
  readonly host: string;
  readonly kind: "app" | "token";
  // Who its commits and comments show as.
  readonly login: string;
  // Whether team work signs in as it on its host.
  readonly team: boolean;
  // Where an admin installs the App on more accounts.
  readonly installUrl: string | null;
  // The accounts the App is installed on, or null for a machine user.
  readonly installedOn: readonly string[] | null;
  // Why the host couldn't say where the App is installed.
  readonly error: string | null;
}
