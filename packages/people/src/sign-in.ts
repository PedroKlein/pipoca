import { type Clock, systemClock } from "@pipoca/protocol";
import { createHash } from "node:crypto";
import {
  checkedName,
  InvalidCredentials,
  maxNameLength,
  type People,
  type PeopleStore,
  type StoredUser,
  type User,
} from "./people";
import { sameText, secretToken, tokenHash } from "./tokens";

export interface Credentials {
  readonly name: string;
  readonly password: string;
}

export interface SignInStatus {
  readonly user: User | null;
  // No user exists yet, so the setup link creates the first one.
  readonly setup: boolean;
  // Off when people sign in only through a plugin, such as OIDC.
  readonly passwordLogin: boolean;
  // One person's install, signed in through links from `pipoca link`.
  readonly solo: boolean;
}

interface Failures {
  count: number;
  readonly since: number;
}

// A copied database holds no usable browser session.
interface SignInLink {
  readonly user: User;
  readonly expires: number;
  readonly challenge?: string;
}

const cookieName = "pipoca-session";
const minPasswordLength = 8;
const signInLinkMs = 10 * 60_000;
const maxPasswordLength = 1024;

// Failed sign-ins for a name from one address before the name is locked
// there for the rest of the window, and for any names from one address
// before that address is. A stranger elsewhere can't lock a person out.
const maxFailures = 10;
const maxAddressFailures = 50;
const failureWindowMs = 15 * 60_000;
// Bounds memory when many addresses guess at once; the oldest go first.
const maxTracked = 100_000;

// How people get into the web app: the first user's setup link, a password,
// an invite, or a one-time link, each ending in a browser session cookie.
export class SignIn {
  readonly #people: People;
  readonly #store: PeopleStore;
  readonly #clock: Clock;
  readonly #passwordLogin: boolean;
  // How long a browser stays signed in.
  readonly #sessionDays: () => number;
  readonly #failures = new Map<string, Failures>();
  readonly #links = new Map<string, SignInLink>();
  #setupToken: string | undefined;

  constructor(
    people: People,
    store: PeopleStore,
    options: {
      readonly passwordLogin?: boolean;
      readonly clock?: Clock;
      readonly sessionDays?: () => number;
    } = {},
  ) {
    this.#people = people;
    this.#store = store;
    this.#clock = options.clock ?? systemClock;
    this.#passwordLogin = options.passwordLogin ?? true;
    this.#sessionDays = options.sessionDays ?? (() => 30);
    this.#setupToken = people.count === 0 ? secretToken() : undefined;
  }

  // The one-time token of the first user's setup link (ADR 0034).
  get setupToken(): string | undefined {
    return this.#setupToken;
  }

  get passwordLogin(): boolean {
    return this.#passwordLogin && this.#people.soloUser === undefined;
  }

  userOf(request: Request): User | undefined {
    const session = this.browserSessionOf(request);

    const user =
      session === undefined ? undefined : this.userOfSession(session);

    if (user !== undefined) {
      this.#people.active(user.id);
    }

    return user;
  }

  // Names the request's browser session without its token, so something
  // that lasts only as long as the session can check it is still there.
  browserSessionOf(request: Request): string | undefined {
    const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      cookieName,
    );

    return token === null ? undefined : tokenHash(token);
  }

  userOfSession(session: string): User | undefined {
    return this.#store.browserSessionUser(session, this.#iso());
  }

  status(request: Request): SignInStatus {
    return {
      user: this.userOf(request) ?? null,
      setup: this.#people.count === 0,
      passwordLogin: this.#passwordLogin,
      solo: this.#people.soloUser !== undefined,
    };
  }

  // A one-time token that signs a browser in as a solo install's user, for
  // `pipoca link`, which only the server's own system user can ask for.
  link(): string {
    const user = this.#people.soloUser;

    if (user === undefined) {
      throw new Error("sign-in links are only for a solo install");
    }

    return this.#newLink({ user });
  }

  // A one-time token that signs the desktop app's window in as a person
  // signed in in their browser (ADR 0055). It works only with the verifier
  // whose SHA-256 is the challenge, which the app never lets out, so a
  // token another app catches on its way to Pipoca's is no use to it.
  appLink(user: User, challenge: string): string {
    return this.#newLink({ user, challenge });
  }

  // Undefined when the token is wrong, used, too old or missing its
  // verifier.
  redeemLink(token: string, verifier?: string): User | undefined {
    const key = tokenHash(token);
    const link = this.#links.get(key);
    this.#links.delete(key);

    if (link === undefined || link.expires <= this.#clock.now()) {
      return undefined;
    }

    if (
      link.challenge !== undefined &&
      (verifier === undefined ||
        !sameText(
          createHash("sha256").update(verifier).digest("base64url"),
          link.challenge,
        ))
    ) {
      return undefined;
    }

    return link.user;
  }

  #newLink(link: Omit<SignInLink, "expires">): string {
    const now = this.#clock.now();
    for (const [token, { expires }] of this.#links) {
      if (expires <= now) {
        this.#links.delete(token);
      }
    }

    const token = secretToken();
    this.#links.set(tokenHash(token), { ...link, expires: now + signInLinkMs });

    return token;
  }

  // Undefined when the token is wrong or already used.
  async setUp(
    token: string,
    credentials: Credentials,
  ): Promise<User | undefined> {
    const expected = this.#setupToken;
    if (expected === undefined || !sameText(token, expected)) {
      return undefined;
    }

    checkCredentials(credentials);
    this.#setupToken = undefined;

    try {
      return await this.#insert(credentials, true);
    } catch (error) {
      this.#setupToken = expected;
      throw error;
    }
  }

  // A person joining with an invite's link and a password of their own.
  // Undefined when the link doesn't let anyone in any more.
  async joinWithInvite(
    token: string,
    credentials: Credentials,
  ): Promise<User | "off" | "taken" | undefined> {
    if (!this.passwordLogin) {
      return "off";
    }

    const invite = this.#people.inviteFor(token, undefined);
    if (invite === undefined) {
      return undefined;
    }

    checkCredentials(credentials);

    if (this.#store.userByName(credentials.name.trim()) !== undefined) {
      return "taken";
    }

    const user = await this.#insert(credentials, invite.admin);
    this.#people.acceptInvite(invite.id);

    return user;
  }

  async #insert(credentials: Credentials, admin: boolean): Promise<User> {
    const user: StoredUser = {
      id: Bun.randomUUIDv7(),
      name: credentials.name.trim(),
      admin,
      passwordHash: await Bun.password.hash(credentials.password),
      createdAt: this.#iso(),
    };

    this.#store.insertUser(user);

    return { id: user.id, name: user.name, admin: user.admin };
  }

  // The address is the client's, as the server or its trusted proxy saw it.
  async signIn(
    { name, password }: Credentials,
    address: string,
  ): Promise<User | "wrong" | "locked" | "off"> {
    if (!this.#passwordLogin) {
      return "off";
    }

    if (name.length > maxNameLength || password.length > maxPasswordLength) {
      return "wrong";
    }

    const now = this.#clock.now();
    this.#prune(now);

    const byAddress = this.#failuresOf(`address\n${address}`, now);
    if (byAddress.count >= maxAddressFailures) {
      return "locked";
    }

    const user = this.#store.userByName(name);

    // An unknown name costs a verify too, so timing doesn't tell names apart.
    if (user === undefined || user.passwordHash === "") {
      byAddress.count += 1;
      await Bun.password.verify(password, await unknownUserHash);

      return "wrong";
    }

    const nameKey = `user\n${user.id}\n${address}`;
    const forName = this.#failuresOf(nameKey, now);
    if (forName.count >= maxFailures) {
      return "locked";
    }

    // Counted before the verify, so parallel guesses can't all slip past.
    byAddress.count += 1;
    forName.count += 1;

    if (!(await Bun.password.verify(password, user.passwordHash))) {
      return "wrong";
    }

    byAddress.count -= 1;
    this.#failures.delete(nameKey);

    return { id: user.id, name: user.name, admin: user.admin };
  }

  // A fresh window goes to the end, so the map stays in the order windows
  // started and pruning stops at the first one still open.
  #failuresOf(key: string, now: number): Failures {
    const seen = this.#failures.get(key);
    if (seen !== undefined && now - seen.since <= failureWindowMs) {
      return seen;
    }

    const fresh = { count: 0, since: now };
    this.#failures.delete(key);
    this.#failures.set(key, fresh);

    return fresh;
  }

  #prune(now: number): void {
    for (const [key, { since }] of this.#failures) {
      if (now - since <= failureWindowMs && this.#failures.size <= maxTracked) {
        return;
      }

      this.#failures.delete(key);
    }
  }

  // The Set-Cookie value of a new browser session for the user.
  startSession(user: User, request: Request): string {
    const token = secretToken();
    const days = this.#sessionDays();
    const expires = new Date(this.#clock.now() + days * 24 * 60 * 60_000);

    this.#store.insertBrowserSession(
      tokenHash(token),
      user.id,
      expires.toISOString(),
    );

    return new Bun.Cookie(cookieName, token, {
      ...cookieOptions(request),
      maxAge: days * 24 * 60 * 60,
    }).serialize();
  }

  // The Set-Cookie value that clears the browser's session.
  endSession(request: Request): string {
    const token = new Bun.CookieMap(request.headers.get("cookie") ?? "").get(
      cookieName,
    );

    if (token !== null) {
      this.#store.deleteBrowserSession(tokenHash(token));
    }

    return new Bun.Cookie(cookieName, "", {
      ...cookieOptions(request),
      maxAge: 0,
    }).serialize();
  }

  #iso(): string {
    return new Date(this.#clock.now()).toISOString();
  }
}

const unknownUserHash = Bun.password.hash(secretToken("", 16));

// HTTPS usually ends in a gateway in front of the server (ADR 0034).
function cookieOptions(request: Request): Bun.CookieInit {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure:
      new URL(request.url).protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https",
  };
}

function checkCredentials({ name, password }: Credentials): void {
  checkedName(name);

  if (
    password.length < minPasswordLength ||
    password.length > maxPasswordLength
  ) {
    throw new InvalidCredentials(
      `password must be ${String(minPasswordLength)} to ${String(maxPasswordLength)} characters`,
    );
  }
}
