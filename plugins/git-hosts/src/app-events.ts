import type { Collection, ServerContext } from "@pipoca/plugins";
import type { gitHosts, TechnicalUserItem } from "../plugin";
import { type HostCall, hostCall, HostRefused, reach } from "./github";
import type { Hosts } from "./hosts";
import { type AppUser, hearsWebhooks, isApp } from "./technical-users";
import { eventOf } from "./webhooks";

// A key is kept this long, past any redelivery or poll that could repeat it.
const keepMs = 7 * 24 * 3_600_000;

// A pushed commit's checks are followed this long.
const checksMs = 3_600_000;

const noCommit = "0000000000000000000000000000000000000000";

type Fields = Readonly<Record<string, unknown>>;

// Where polling got to in one repository. Lists are compared with what it
// saw last, and each list's ETag lets the host answer 304, which doesn't
// count against the App's rate limit.
interface Polled {
  readonly since: {
    readonly issues: string;
    readonly comments: string;
    readonly reviewComments: string;
  };
  readonly etags: Readonly<Record<string, string>>;
  readonly branches: Readonly<Record<string, string>>;
  readonly tags: readonly string[];
  readonly releases: readonly number[];
  readonly deployments: readonly number[];
  readonly checks: Readonly<
    Record<string, { readonly branch: string; readonly since: number }>
  >;
}

interface Repository {
  readonly name: string;
  readonly defaultBranch: string;
}

// Publishes what an App heard, unless it was published already, and says
// whether it was.
export type Heard = (app: AppUser, kind: string, payload: unknown) => boolean;

// An App's events reach the people who may use it, by its webhook or, when
// the host can't reach the server, by polling with its installation tokens
// (ADR 0060, ADR 0075). Both give the same event for the same change, and
// each is published once.
export function appEvents(
  {
    store,
    events,
    config,
    schedule,
    clock,
    urls,
    log,
    network,
  }: Pick<
    ServerContext<typeof gitHosts>,
    | "store"
    | "events"
    | "config"
    | "schedule"
    | "clock"
    | "urls"
    | "log"
    | "network"
  >,
  hosts: Hosts,
  users: Collection<TechnicalUserItem>,
  installations: (name: string) => readonly string[],
  // Whether the event answered a question, and so isn't one.
  answered: (event: {
    readonly name: string;
    readonly fields: Fields;
  }) => boolean,
): Heard {
  const heard: Heard = (app, kind, payload) => {
    const event = eventOf(app.host, app.name, kind, payload);

    if (event === undefined) {
      return false;
    }

    const fresh =
      store.run(
        "insert into git_hosts_heard (key, heard_at) values (?, ?) on conflict do nothing",
        `${app.name} ${event.key}`,
        clock.now(),
      ).changes === 1;

    if (fresh && !answered(event)) {
      events.emit(event.name, event.fields, { to: app.users });
    }

    return fresh;
  };

  const polls = (app: AppUser): boolean =>
    !hearsWebhooks(urls) || app.app.webhookSecret === undefined;

  schedule.every(
    "events",
    () => config.get().eventSeconds * 1000,
    async () => {
      const started = clock.now();
      let repositories = 0;
      let published = 0;
      let failed = 0;

      store.run(
        "delete from git_hosts_heard where heard_at < ?",
        started - keepMs,
      );

      for (const user of users.list()) {
        const host = hosts.get(user.host);

        if (!isApp(user) || !polls(user) || host === undefined) {
          continue;
        }

        for (const token of installations(user.name)) {
          // An App's events are team work (ADR 0080).
          const poller = pollerOf(
            hostCall(host, network, "team"),
            token,
            (kind, payload) => heard(user, kind, payload),
          );

          try {
            for (const repository of await poller.repositories()) {
              repositories += 1;

              try {
                published += await poller.poll(repository, {
                  load: (name) => loaded(store, user.name, name),
                  save: (name, state) => {
                    saved(store, user.name, name, state);
                  },
                  now: clock.now(),
                });
              } catch (failure) {
                failed += 1;
                logged(log, user.name, repository.name, failure);
              }
            }
          } catch (failure) {
            failed += 1;
            logged(log, user.name, undefined, failure);
          }
        }
      }

      if (repositories > 0 || failed > 0) {
        log("app events polled", {
          repositories,
          published,
          failed,
          ms: clock.now() - started,
        });
      }
    },
  );

  return heard;
}

interface Saved {
  readonly load: (repository: string) => Polled | undefined;
  readonly save: (repository: string, state: Polled) => void;
  readonly now: number;
}

function pollerOf(
  host: HostCall,
  token: string,
  heard: (kind: string, payload: unknown) => boolean,
) {
  const request = async (
    path: string,
    etag?: string,
  ): Promise<{ readonly body: unknown; readonly etag: string } | undefined> => {
    const response = await reach(host, `${host.api}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        ...(etag !== undefined && { "if-none-match": etag }),
      },
    });

    if (response.status === 304) {
      return undefined;
    }

    if (!response.ok) {
      throw new HostRefused(
        `${host.host} answered ${String(response.status)} to ${path}`,
      );
    }

    return {
      body: await response.json(),
      etag: response.headers.get("etag") ?? "",
    };
  };

  const get = async (path: string): Promise<unknown> =>
    (await request(path))?.body;

  return {
    repositories: async (): Promise<readonly Repository[]> => {
      const { repositories } = fieldsOf(
        await get("/installation/repositories?per_page=100"),
      );

      return list(repositories).flatMap((each) =>
        typeof each["full_name"] === "string"
          ? [
              {
                name: each["full_name"],
                defaultBranch: text(each["default_branch"]),
              },
            ]
          : [],
      );
    },

    // Publishes what changed in the repository since the last poll, and
    // returns how many events it published. The first poll only notes
    // where things are.
    poll: async (
      { name, defaultBranch }: Repository,
      { load, save, now }: Saved,
    ): Promise<number> => {
      const prior = load(name);
      const at = isoOf(now);
      const repo = `/repos/${name}`;
      const etags: Record<string, string> = { ...prior?.etags };
      let published = 0;

      const emit = (kind: string, payload: Fields): void => {
        if (heard(kind, { ...payload, repository: { full_name: name } })) {
          published += 1;
        }
      };

      // The answer at path, or undefined when it is as it was.
      const changed = async (
        source: string,
        path: string,
      ): Promise<unknown> => {
        const answer = await request(path, etags[source]);

        if (answer === undefined) {
          return undefined;
        }

        etags[source] = answer.etag;

        return answer.body;
      };

      const changedList = async (
        source: string,
        path: string,
      ): Promise<readonly Fields[] | undefined> => {
        const body = await changed(source, path);

        return body === undefined ? undefined : list(body);
      };

      const since = async (
        source: keyof Polled["since"],
        path: string,
        each: (item: Fields, cursor: string) => Promise<void> | void,
      ): Promise<string> => {
        const cursor = prior?.since[source] ?? at;

        if (prior === undefined) {
          return cursor;
        }

        const items =
          (await changedList(
            source,
            `${path}${path.includes("?") ? "&" : "?"}sort=updated&direction=asc&per_page=100&since=${cursor}`,
          )) ?? [];

        for (const item of items) {
          await each(item, cursor);
        }

        return items.reduce(
          (latest, item) =>
            later(text(item["updated_at"]), latest)
              ? text(item["updated_at"])
              : latest,
          cursor,
        );
      };

      const issues = await since(
        "issues",
        `${repo}/issues?state=all`,
        async (issue, cursor) => {
          const action = actionOf(issue, cursor);
          const sender = action === "opened" ? issue["user"] : undefined;

          if (issue["pull_request"] === undefined) {
            emit("issues", { action, sender, issue });

            return;
          }

          const number = String(issue["number"]);
          const pull = fieldsOf(await get(`${repo}/pulls/${number}`));

          emit("pull_request", {
            action: actionOf(pull, cursor),
            sender,
            pull_request: pull,
          });

          for (const review of list(
            await get(`${repo}/pulls/${number}/reviews?per_page=100`),
          )) {
            if (
              review["state"] !== "PENDING" &&
              !later(cursor, text(review["submitted_at"]))
            ) {
              emit("pull_request_review", {
                action: "submitted",
                sender: review["user"],
                review,
                pull_request: { number: issue["number"] },
              });
            }
          }
        },
      );

      const comments = await since(
        "comments",
        `${repo}/issues/comments`,
        (comment, cursor) => {
          const action = later(cursor, text(comment["created_at"]))
            ? "edited"
            : "created";

          emit("issue_comment", {
            action,
            sender: comment["user"],
            comment,
            issue: {
              number: numberIn(comment["issue_url"]),
              ...(text(comment["html_url"]).includes("/pull/") && {
                pull_request: {},
              }),
            },
          });
        },
      );

      const reviewComments = await since(
        "reviewComments",
        `${repo}/pulls/comments`,
        (comment, cursor) => {
          emit("pull_request_review_comment", {
            action: later(cursor, text(comment["created_at"]))
              ? "edited"
              : "created",
            sender: comment["user"],
            comment,
            pull_request: { number: numberIn(comment["pull_request_url"]) },
          });
        },
      );

      const checks = { ...prior?.checks };

      const branches = await changedList(
        "branches",
        `${repo}/branches?per_page=100`,
      );

      const heads: Record<string, string> =
        branches === undefined
          ? { ...prior?.branches }
          : Object.fromEntries(
              branches.map((branch) => [
                text(branch["name"]),
                text(fieldsOf(branch["commit"])["sha"]),
              ]),
            );

      if (prior !== undefined && branches !== undefined) {
        const names = new Set([
          ...Object.keys(prior.branches),
          ...Object.keys(heads),
        ]);

        for (const branch of names) {
          const before = prior.branches[branch];
          const after = heads[branch] ?? noCommit;

          if (before === after) {
            continue;
          }

          const base = before ?? prior.branches[defaultBranch];

          const compared =
            after === noCommit || base === undefined
              ? {}
              : fieldsOf(await get(`${repo}/compare/${base}...${after}`));

          if (after !== noCommit) {
            checks[after] = { branch, since: now };
          }

          emit("push", {
            ref: `refs/heads/${branch}`,
            after,
            sender: fieldsOf(list(compared["commits"]).at(-1))["author"],
            commits: [changesOf(list(compared["files"]))],
          });
        }
      }

      const tags = await changedList("tags", `${repo}/tags?per_page=100`);
      const tagNames = tags?.map((tag) => text(tag["name"]));

      for (const tag of tagNames ?? []) {
        if (prior !== undefined && !prior.tags.includes(tag)) {
          emit("create", { ref_type: "tag", ref: tag });
        }
      }

      const releases = (
        await changedList("releases", `${repo}/releases?per_page=30`)
      )?.filter((release) => release["draft"] !== true);

      for (const release of releases ?? []) {
        if (prior !== undefined && !prior.releases.includes(id(release))) {
          emit("release", {
            action: "published",
            sender: release["author"],
            release,
          });
        }
      }

      const deployments = await changedList(
        "deployments",
        `${repo}/deployments?per_page=30`,
      );

      for (const deployment of deployments ?? []) {
        if (
          prior !== undefined &&
          !prior.deployments.includes(id(deployment))
        ) {
          emit("deployment", {
            action: "created",
            sender: deployment["creator"],
            deployment,
          });
        }
      }

      for (const [sha, { branch, since: from }] of Object.entries(checks)) {
        const source = `checks ${sha}`;

        const runs =
          now - from > checksMs
            ? []
            : await changed(
                source,
                `${repo}/commits/${sha}/check-runs?per_page=100`,
              ).then((answer) =>
                answer === undefined
                  ? undefined
                  : list(fieldsOf(answer)["check_runs"]),
              );

        for (const run of runs ?? []) {
          if (run["status"] === "completed") {
            emit("check_run", {
              action: "completed",
              check_run: { ...run, check_suite: { head_branch: branch } },
            });
          }
        }

        if (
          now - from > checksMs ||
          (runs !== undefined &&
            runs.length > 0 &&
            runs.every((run) => run["status"] === "completed"))
        ) {
          Reflect.deleteProperty(checks, sha);
          Reflect.deleteProperty(etags, source);
        }
      }

      save(name, {
        since: { issues, comments, reviewComments },
        etags,
        branches: heads,
        tags: tagNames ?? prior?.tags ?? [],
        releases: releases?.map(id) ?? prior?.releases ?? [],
        deployments: deployments?.map(id) ?? prior?.deployments ?? [],
        checks,
      });

      return published;
    },
  };
}

// What polling can tell of a change: an item made or closed since the
// cursor, or one that changed otherwise.
function actionOf(item: Fields, cursor: string): string {
  if (!later(cursor, text(item["created_at"]))) {
    return "opened";
  }

  const closed = text(item["closed_at"]);

  return closed !== "" && !later(cursor, closed) ? "closed" : "updated";
}

// A compare's files as one commit's, as a push's webhook lists them.
function changesOf(files: readonly Fields[]): Fields {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];

  for (const file of files) {
    const path = text(file["filename"]);

    switch (file["status"]) {
      case "added":
        added.push(path);
        break;
      case "removed":
        removed.push(path);
        break;
      case "renamed":
        added.push(path);
        removed.push(text(file["previous_filename"]));
        break;
      default:
        modified.push(path);
    }
  }

  return { added, modified, removed };
}

function loaded(
  store: ServerContext<typeof gitHosts>["store"],
  app: string,
  repository: string,
): Polled | undefined {
  const row = store.get<{ state: string }>(
    "select state from git_hosts_polled where technical_user = ? and repository = ?",
    app,
    repository,
  );

  return row === undefined ? undefined : (JSON.parse(row.state) as Polled);
}

function saved(
  store: ServerContext<typeof gitHosts>["store"],
  app: string,
  repository: string,
  state: Polled,
): void {
  store.run(
    "insert into git_hosts_polled (technical_user, repository, state) values (?, ?, ?) on conflict (technical_user, repository) do update set state = excluded.state",
    app,
    repository,
    JSON.stringify(state),
  );
}

function logged(
  log: ServerContext<typeof gitHosts>["log"],
  app: string,
  repository: string | undefined,
  failure: unknown,
): void {
  if (!(failure instanceof HostRefused)) {
    throw failure;
  }

  log("app events poll failed", {
    name: app,
    repository,
    error: failure.message,
  });
}

// GitHub's own form, which its since parameter takes.
function isoOf(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function later(a: string, b: string): boolean {
  return Date.parse(a) > Date.parse(b);
}

function numberIn(url: unknown): number {
  return Number(/\/(\d+)$/.exec(text(url))?.[1] ?? 0);
}

function id(item: Fields): number {
  return typeof item["id"] === "number" ? item["id"] : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): readonly Fields[] {
  return (Array.isArray(value) ? value : []).map(fieldsOf);
}

function fieldsOf(value: unknown): Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : {};
}
