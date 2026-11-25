import { join } from "node:path";
import type { GitLogin } from "@pipoca/protocol";

// The hosts a Session signs in to: its owner's connections (ADR 0043), and
// the Environment's GH_TOKEN for github.com when the owner has no login there
// (ADR 0034).
export function hostLogins(
  logins: readonly GitLogin[],
  variables: Readonly<Record<string, string>>,
): readonly GitLogin[] {
  const token = variables["GH_TOKEN"];

  return token === undefined ||
    token === "" ||
    logins.some(({ host }) => host === "github.com")
    ? logins
    : [...logins, { host: "github.com", token }];
}

// Lets git authenticate to each host over https, for clones, the Session's
// pushes and Profile packages. For each host, the empty helper first stops the
// machine's own helpers, so none answers with another login or keeps the
// token. The entries follow any the environment already has. With a tokens
// folder, git reads each host's token from its file there on each use, so the
// tokens can change while the Session runs.
export function gitCredentials(
  logins: readonly GitLogin[],
  environment: Readonly<Record<string, string | undefined>>,
  tokens?: string,
): Readonly<Record<string, string>> {
  if (logins.length === 0) {
    return {};
  }

  const count = Number(environment["GIT_CONFIG_COUNT"] ?? 0);
  const first = Number.isSafeInteger(count) && count > 0 ? count : 0;

  const password = (index: number): string =>
    tokens === undefined
      ? `$${tokenVariable(index)}`
      : `$(cat "$${tokensVariable}/${String(index)}")`;

  const entries = logins.flatMap(({ host }, index) => {
    const key = `credential.https://${host}.helper`;

    return [
      [key, ""],
      [
        key,
        `!f() { test "$1" = get && echo username=x-access-token && echo "password=${password(index)}"; }; f`,
      ],
    ];
  });

  const github = logins.find(({ host }) => host === "github.com");

  const secrets =
    tokens === undefined
      ? {
          ...Object.fromEntries(
            logins.map(({ token }, index) => [tokenVariable(index), token]),
          ),
          ...(github && { GH_TOKEN: github.token }),
        }
      : { [tokensVariable]: tokens };

  return {
    ...secrets,
    GIT_CONFIG_COUNT: String(first + entries.length),
    ...Object.fromEntries(
      entries.flatMap(([key, value], index) => [
        [`GIT_CONFIG_KEY_${String(first + index)}`, key],
        [`GIT_CONFIG_VALUE_${String(first + index)}`, value],
      ]),
    ),
  };
}

// What a Session's own git and gh sign in with: variables that point them at
// files in dir, by path from dir, which they read on each use. Writing the
// files again with fresh tokens reaches the running Session, since an App's
// installation tokens expire within the hour. Logins added later keep the
// earlier ones' order, so git still finds each host's token. Without a
// config.yml at version 1, gh tries to migrate hosts.yml and asks each host
// who signed in.
export function sessionCredentials(
  logins: readonly GitLogin[],
  environment: Readonly<Record<string, string | undefined>>,
  dir: string,
): {
  readonly variables: Readonly<Record<string, string>>;
  readonly files: Readonly<Record<string, string>>;
} {
  if (logins.length === 0) {
    return { variables: {}, files: {} };
  }

  return {
    variables: {
      ...gitCredentials(logins, environment, join(dir, "tokens")),
      GH_CONFIG_DIR: join(dir, "gh"),
    },
    files: {
      ...Object.fromEntries(
        logins.map(({ token }, index) => [`tokens/${String(index)}`, token]),
      ),
      "gh/config.yml": 'version: "1"\n',
      "gh/hosts.yml": logins
        .map(
          ({ host, token }) =>
            `${JSON.stringify(host)}:\n  oauth_token: ${JSON.stringify(token)}\n  git_protocol: https\n`,
        )
        .join(""),
    },
  };
}

const tokensVariable = "PIPOCA_GIT_TOKENS";

function tokenVariable(index: number): string {
  return `PIPOCA_GIT_TOKEN_${String(index)}`;
}

// Tokens git hosts take, which an Environment may hold as secrets.
const writeTokens = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITLAB_TOKEN",
];

// An Environment's variables for a Session that proposes: without the git
// hosts' tokens, and with the machine's own credential helpers off, so its
// git can't sign in as anyone who could push (ADR 0076).
export function withoutGitTokens(
  variables: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const kept = Object.fromEntries(
    Object.entries(variables).filter(([name]) => !writeTokens.includes(name)),
  );

  const count = Number(
    kept["GIT_CONFIG_COUNT"] ?? process.env["GIT_CONFIG_COUNT"] ?? 0,
  );

  const first = Number.isSafeInteger(count) && count > 0 ? count : 0;

  return {
    ...kept,
    GIT_CONFIG_COUNT: String(first + 1),
    [`GIT_CONFIG_KEY_${String(first)}`]: "credential.helper",
    [`GIT_CONFIG_VALUE_${String(first)}`]: "",
  };
}
