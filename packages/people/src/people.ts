import type {
  Account,
  AccountChange,
  Invite,
  Person,
  SetupState,
} from "@pipoca/protocol";
import { type Clock, systemClock } from "@pipoca/protocol";
import { secretToken, tokenHash } from "./tokens";

export interface User {
  readonly id: string;
  readonly name: string;
  // Installs, updates and turns on plugins, and changes their settings.
  readonly admin: boolean;
}

export interface StoredUser extends User {
  // Empty for a user who signs in only through a plugin, such as OIDC.
  readonly passwordHash: string;
  readonly createdAt: string;
  // The name people see, such as "Pedro Klein", when it isn't the username.
  readonly displayName?: string;
}

// A token an MCP client such as Claude Code uses to act as its user
// (ADR 0035). Only its hash is kept.
export interface AccessToken {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface PeopleStore {
  readonly userCount: () => number;
  readonly userByName: (name: string) => StoredUser | undefined;
  readonly userById: (id: string) => User | undefined;
  readonly users: () => readonly User[];
  readonly account: (id: string) => Account | undefined;
  readonly setDisplayName: (id: string, name: string | null) => void;
  readonly setDefaultEnvironment: (
    id: string,
    environment: string | null,
  ) => void;
  readonly insertUser: (user: StoredUser) => void;
  readonly setAdmin: (id: string, admin: boolean) => void;
  readonly people: () => readonly Person[];
  readonly setLastActive: (id: string, at: string) => void;
  readonly insertBrowserSession: (
    tokenHash: string,
    userId: string,
    expiresAt: string,
  ) => void;
  // Expired browser sessions are left out.
  readonly browserSessionUser: (
    tokenHash: string,
    now: string,
  ) => User | undefined;
  readonly deleteBrowserSession: (tokenHash: string) => void;
  // Every browser session and access token of the user.
  readonly deleteSignIns: (userId: string) => void;
  readonly insertInvite: (invite: Invite, tokenHash: string) => void;
  // Unexpired invites that can still be used.
  readonly invites: (now: string) => readonly Invite[];
  readonly inviteByToken: (
    tokenHash: string,
    now: string,
  ) => Invite | undefined;
  readonly inviteByEmail: (email: string, now: string) => Invite | undefined;
  // Whether there was an invite with the id.
  readonly deleteInvite: (id: string) => boolean;
  readonly useInvite: (id: string) => void;
  readonly insertAccessToken: (token: AccessToken, tokenHash: string) => void;
  readonly accessTokens: (userId: string) => readonly AccessToken[];
  readonly accessTokenUser: (tokenHash: string) => User | undefined;
  // Whether the user had a token with the id.
  readonly deleteAccessToken: (id: string, userId: string) => boolean;
  // The plugin pages a user pinned in the sidebar, null until they pin or
  // unpin one (ADR 0040).
  readonly pinnedPages: (userId: string) => readonly string[] | null;
  readonly setPinnedPages: (
    userId: string,
    pages: readonly string[] | null,
  ) => void;
  readonly setup: (userId: string) => SetupState;
  readonly setSetup: (userId: string, state: SetupState) => void;
}

export class InvalidCredentials extends Error {}

export const maxNameLength = 64;

// How stale a person's last use of the web app may get before it is
// written again.
const lastActiveStepMs = 60_000;

// The people of a server: their roles, invites, access tokens and what each
// keeps for themselves.
export class People {
  readonly #store: PeopleStore;
  readonly #clock: Clock;
  readonly #lastActive = new Map<string, number>();
  // The one user of a solo install (ADR 0053).
  readonly #soloUser: User | undefined;

  constructor(
    store: PeopleStore,
    options: { readonly clock?: Clock; readonly solo?: string } = {},
  ) {
    this.#store = store;
    this.#clock = options.clock ?? systemClock;

    if (options.solo !== undefined) {
      this.#soloUser =
        store.users()[0] ?? this.createUser(options.solo, true) ?? undefined;
    }
  }

  get soloUser(): User | undefined {
    return this.#soloUser;
  }

  get count(): number {
    return this.#store.userCount();
  }

  userById(id: string): User | undefined {
    return this.#store.userById(id);
  }

  users(): readonly User[] {
    return this.#store.users();
  }

  account(id: string): Account | undefined {
    return this.#store.account(id);
  }

  // The caller checks that a default Environment is the person's own.
  changeAccount(id: string, change: AccountChange): Account | undefined {
    if (change.displayName !== undefined) {
      this.#store.setDisplayName(
        id,
        checkedDisplayName(change.displayName) ?? null,
      );
    }

    if (change.defaultEnvironment !== undefined) {
      this.#store.setDefaultEnvironment(id, change.defaultEnvironment);
    }

    return this.#store.account(id);
  }

  people(): readonly Person[] {
    return this.#store.people();
  }

  active(userId: string): void {
    const now = this.#clock.now();
    if (now - (this.#lastActive.get(userId) ?? 0) < lastActiveStepMs) {
      return;
    }

    this.#lastActive.set(userId, now);
    this.#store.setLastActive(userId, new Date(now).toISOString());
  }

  // A user without a password, or undefined when the name is taken.
  createUser(name: string, admin: boolean): User | undefined {
    if (this.#soloUser !== undefined) {
      throw new InvalidCredentials("a solo install has only its own user");
    }

    const trimmed = checkedName(name);

    if (this.#store.userByName(trimmed) !== undefined) {
      return undefined;
    }

    const user = { id: Bun.randomUUIDv7(), name: trimmed, admin };

    this.#store.insertUser({
      ...user,
      passwordHash: "",
      createdAt: this.#iso(),
    });

    return user;
  }

  // For a sign-in plugin that reads roles from its provider.
  setAdmin(id: string, admin: boolean): void {
    this.#store.setAdmin(id, admin);
  }

  // The server always keeps an admin.
  changeRole(id: string, admin: boolean): Person | "not_found" | "last_admin" {
    const people = this.#store.people();
    if (!people.some((person) => person.id === id)) {
      return "not_found";
    }

    if (!admin && !people.some((person) => person.admin && person.id !== id)) {
      return "last_admin";
    }

    this.#store.setAdmin(id, admin);

    return (
      this.#store.people().find((person) => person.id === id) ?? "not_found"
    );
  }

  // One invite for each email, or a link anyone may join with when there
  // are none. Each token is only in the answer, and only its hash is kept.
  invite(
    createdBy: string,
    emails: readonly string[],
    admin: boolean,
    days: number,
  ): readonly (Invite & { readonly token: string })[] {
    const now = this.#clock.now();

    const unique = [
      ...new Set(emails.map((email) => email.trim().toLowerCase())),
    ];

    return (unique.length === 0 ? [null] : unique).map((email) => {
      const token = secretToken("", 24);

      const invite: Invite = {
        id: Bun.randomUUIDv7(),
        email,
        admin,
        createdBy,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + days * 86_400_000).toISOString(),
        uses: 0,
      };

      this.#store.insertInvite(invite, tokenHash(token));

      return { ...invite, token };
    });
  }

  invites(): readonly Invite[] {
    return this.#store.invites(this.#iso());
  }

  revokeInvite(id: string): boolean {
    return this.#store.deleteInvite(id);
  }

  // The invite that lets someone in: the one whose link they followed, or
  // else one for their email.
  inviteFor(
    token: string | undefined,
    email: string | undefined,
  ): Invite | undefined {
    const now = this.#iso();

    return (
      (token === undefined
        ? undefined
        : this.#store.inviteByToken(tokenHash(token), now)) ??
      (email === undefined
        ? undefined
        : this.#store.inviteByEmail(email.toLowerCase(), now))
    );
  }

  acceptInvite(id: string): void {
    this.#store.useInvite(id);
  }

  // The secret is shown once, when the token is made.
  newAccessToken(
    userId: string,
    name: string,
  ): { readonly token: AccessToken; readonly secret: string } {
    const secret = secretToken("pcm_");

    const token: AccessToken = {
      id: Bun.randomUUIDv7(),
      userId,
      name: checkedName(name),
      createdAt: this.#iso(),
    };

    this.#store.insertAccessToken(token, tokenHash(secret));

    return { token, secret };
  }

  accessTokens(userId: string): readonly AccessToken[] {
    return this.#store.accessTokens(userId);
  }

  revokeAccessToken(userId: string, id: string): boolean {
    return this.#store.deleteAccessToken(id, userId);
  }

  // The user whose access token the request carries.
  userOfAccessToken(request: Request): User | undefined {
    const token = /^bearer\s+(pcm_\S+)$/i.exec(
      request.headers.get("authorization") ?? "",
    )?.[1];

    return token === undefined
      ? undefined
      : this.#store.accessTokenUser(tokenHash(token));
  }

  pinnedPages(userId: string): readonly string[] | null {
    return this.#store.pinnedPages(userId);
  }

  pinPages(userId: string, pages: readonly string[] | null): void {
    this.#store.setPinnedPages(userId, pages);
  }

  setup(userId: string): SetupState {
    return this.#store.setup(userId);
  }

  finishSetup(userId: string): void {
    this.#store.setSetup(userId, { ...this.setup(userId), finished: true });
  }

  dismissSetupStep(userId: string, step: string): void {
    const state = this.setup(userId);

    if (!state.dismissed.includes(step)) {
      this.#store.setSetup(userId, {
        ...state,
        dismissed: [...state.dismissed, step],
      });
    }
  }

  #iso(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}

// Undefined for a name that is only spaces.
export function checkedDisplayName(name: string): string | undefined {
  const trimmed = name.trim();

  if (trimmed.length > maxNameLength) {
    throw new InvalidCredentials(
      `display name must be at most ${String(maxNameLength)} characters`,
    );
  }

  return trimmed === "" ? undefined : trimmed;
}

export function checkedName(name: string): string {
  const trimmed = name.trim();

  if (trimmed === "" || trimmed.length > maxNameLength) {
    throw new InvalidCredentials(
      `name must be 1 to ${String(maxNameLength)} characters`,
    );
  }

  return trimmed;
}
