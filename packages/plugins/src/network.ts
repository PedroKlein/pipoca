import type { Owner } from "@pipoca/protocol";
import { HttpError } from "./http";

// How a plugin calls out (ADR 0080). A call to a private host goes through
// an Environment of its owner that reaches it; any other goes straight out.
export interface Network {
  readonly fetch: (
    url: string | URL,
    init?: RequestInit,
    on?: OnBehalf,
  ) => Promise<Response>;
  // The variables that send a child process's https calls to the URL's host
  // the same way, such as git's. Done ends them.
  readonly env: (url: string, on?: OnBehalf) => Promise<NetworkEnv>;
  // The private host an admin listed at the URL, if it is one.
  readonly privateHost: (
    url: string | URL,
  ) => { readonly teamWatch: boolean } | undefined;
}

// Whose call it is, which picks the Environments it may go through, and
// what it does, in a few words for the relay log, such as "repo search".
export interface OnBehalf {
  readonly owner: Owner;
  readonly action?: string;
}

export interface NetworkEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly done: () => void;
}

// No Environment carries a call to a private host for its owner now.
export class Unreachable extends HttpError {
  constructor(host: string, why: string) {
    super(409, `${host} is a private host and ${why}.`, "unreachable", {
      host,
    });
  }
}
