import { randomUUID } from "node:crypto";
import type { PluginStore } from "@pipoca/plugins";
import type { Preferences, PullWatch } from "./model";
import type { PullRef, PullState, Remark } from "./pulls";

// What the poller remembers of a pull request between polls.
export interface Seen {
  readonly head: string;
  // The head whose failed checks the Session already heard about.
  readonly failedHead: string | null;
  readonly conflicts: boolean | null;
  readonly remarks: readonly string[];
}

export interface Watch extends PullRef {
  readonly id: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly url: string;
  readonly autoFix: boolean;
  readonly briefed: boolean;
  readonly seen: Seen | null;
  // News a Session that was offline hasn't had yet.
  readonly pending: string | null;
  readonly view: PullWatch;
}

export interface WatchStore {
  readonly all: () => readonly Watch[];
  readonly get: (id: string) => Watch | undefined;
  readonly ofSession: (sessionId: string) => readonly Watch[];
  readonly add: (
    sessionId: string,
    userId: string,
    url: string,
    ref: PullRef,
    autoFix: boolean,
  ) => Watch;
  readonly update: (id: string, change: Partial<Watch>) => void;
  readonly remove: (id: string) => void;
  readonly preferences: (userId: string) => Preferences;
  readonly prefer: (userId: string, preferences: Preferences) => void;
}

interface Row {
  id: string;
  session_id: string;
  user_id: string;
  url: string;
  host: string;
  repository: string;
  number: number;
  auto_fix: number;
  briefed: number;
  seen: string | null;
  pending: string | null;
  view: string | null;
}

const watches = `"git-hosts_watches"`;
const preferences = `"git-hosts_preferences"`;

// Watched pull requests and each person's choices are runtime data, so they
// live in SQLite (ADR 0051).
export function watchStore(store: PluginStore): WatchStore {
  store.exec(`
    create table if not exists ${watches} (
      id text primary key,
      session_id text not null,
      user_id text not null,
      url text not null,
      host text not null,
      repository text not null,
      number integer not null,
      auto_fix integer not null,
      briefed integer not null default 0,
      seen text,
      pending text,
      view text,
      unique (session_id, url)
    )
  `);

  store.exec(`
    create table if not exists ${preferences} (
      user_id text primary key,
      auto_fix integer not null,
      reply integer not null
    )
  `);

  const watchOf = (row: Row): Watch => {
    const base = {
      id: row.id,
      sessionId: row.session_id,
      userId: row.user_id,
      url: row.url,
      host: row.host,
      repository: row.repository,
      number: row.number,
      autoFix: row.auto_fix === 1,
    };

    return {
      ...base,
      briefed: row.briefed === 1,
      seen: row.seen === null ? null : (JSON.parse(row.seen) as Seen),
      pending: row.pending,
      view:
        row.view === null
          ? {
              id: row.id,
              url: row.url,
              title: `${row.repository}#${String(row.number)}`,
              state: "open",
              checks: { passed: 0, failed: 0, pending: 0 },
              conflicts: null,
              changesRequested: false,
              autoFix: base.autoFix,
              error: null,
            }
          : { ...(JSON.parse(row.view) as PullWatch), autoFix: base.autoFix },
    };
  };

  const select = (where: string, ...params: (string | number)[]) =>
    (store.all(`select * from ${watches} ${where}`, ...params) as Row[]).map(
      watchOf,
    );

  return {
    all: () => select("order by id"),
    get: (id) => select("where id = ?", id)[0],
    ofSession: (sessionId) =>
      select("where session_id = ? order by url", sessionId),
    add: (sessionId, userId, url, ref, autoFix) => {
      store.run(
        `insert into ${watches} (id, session_id, user_id, url, host, repository, number, auto_fix) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (session_id, url) do nothing`,
        randomUUID(),
        sessionId,
        userId,
        url,
        ref.host,
        ref.repository,
        ref.number,
        autoFix ? 1 : 0,
      );

      const [added] = select(
        "where session_id = ? and url = ?",
        sessionId,
        url,
      );

      if (added === undefined) {
        throw new Error(`no watch for ${url} after adding it`);
      }

      return added;
    },
    update: (id, change) => {
      const columns: [string, string | number | null][] = [
        ...(change.autoFix === undefined
          ? []
          : [["auto_fix", change.autoFix ? 1 : 0] as [string, number]]),
        ...(change.briefed === undefined
          ? []
          : [["briefed", change.briefed ? 1 : 0] as [string, number]]),
        ...(change.seen === undefined
          ? []
          : [
              [
                "seen",
                change.seen === null ? null : JSON.stringify(change.seen),
              ] as [string, string | null],
            ]),
        ...(change.pending === undefined
          ? []
          : [["pending", change.pending] as [string, string | null]]),
        ...(change.view === undefined
          ? []
          : [["view", JSON.stringify(change.view)] as [string, string]]),
      ];

      for (const [column, value] of columns) {
        store.run(
          `update ${watches} set ${column} = ? where id = ?`,
          value,
          id,
        );
      }
    },
    remove: (id) => {
      store.run(`delete from ${watches} where id = ?`, id);
    },
    preferences: (userId) => {
      const [row] = store.all(
        `select auto_fix, reply from ${preferences} where user_id = ?`,
        userId,
      ) as { auto_fix: number; reply: number }[];

      return row === undefined
        ? { autoFix: true, reply: false }
        : { autoFix: row.auto_fix === 1, reply: row.reply === 1 };
    },
    prefer: (userId, { autoFix, reply }) => {
      store.run(
        `insert into ${preferences} (user_id, auto_fix, reply) values (?, ?, ?) on conflict (user_id) do update set auto_fix = excluded.auto_fix, reply = excluded.reply`,
        userId,
        autoFix ? 1 : 0,
        reply ? 1 : 0,
      );
    },
  };
}

// The lines a Session should hear about since what it last saw, and what to
// remember now. The first poll only remembers the reviews already there.
export function newsOf(
  seen: Seen | null,
  state: PullState,
  login: string,
): { readonly news: readonly string[]; readonly seen: Seen } {
  const known = new Set(seen?.remarks ?? state.remarks.map(({ id }) => id));
  const news: string[] = [];

  const failed = state.checks.filter(({ status }) => status === "failed");
  const settled = state.checks.every(({ status }) => status !== "pending");

  const reportFailure =
    settled && failed.length > 0 && seen?.failedHead !== state.head;

  if (reportFailure) {
    news.push(
      `Checks failed on ${state.head.slice(0, 7)}: ${failed
        .map(({ name, url }) => (url === null ? name : `${name} (${url})`))
        .join(", ")}`,
    );
  }

  for (const remark of state.remarks) {
    if (!known.has(remark.id) && remark.author !== login) {
      news.push(remarkLine(remark));
    }
  }

  if (state.conflicts === true && seen?.conflicts !== true) {
    news.push(
      "It has a merge conflict with its base branch. Merge the base branch in, resolve it, and push.",
    );
  }

  return {
    news,
    seen: {
      head: state.head,
      failedHead: reportFailure ? state.head : (seen?.failedHead ?? null),
      conflicts: state.conflicts ?? seen?.conflicts ?? null,
      remarks: state.remarks.map(({ id }) => id),
    },
  };
}

const bodyLimit = 600;

function remarkLine({ author, kind, body, url, path }: Remark): string {
  const said =
    body.trim() === ""
      ? ""
      : `: ${body.trim().slice(0, bodyLimit)}${body.length > bodyLimit ? "…" : ""}`;

  const what = {
    approved: "approved it",
    changes_requested: "requested changes",
    commented: "reviewed it",
    line: `commented on ${path ?? "a line"}`,
  }[kind];

  return `${author} ${what}${said} (${url})`;
}

// What the Session reads first, as Claude Code's first event carries its
// rules (ADR 0051).
export function rules(reply: boolean): string {
  return [
    "You are watching this pull request. Pipoca sends you its news: failed checks, reviews, merge conflicts, and when it merges or closes.",
    "For each piece of news, look at the pull request as it is now, then:",
    "- When a fix is clear and doesn't go against what the user asked earlier, make it, run the checks you can, push to the pull request's branch, and say in a sentence what you changed.",
    "- When a request is ambiguous or changes the design, ask the user before acting.",
    "- When news is a duplicate or needs no change, say so in a line and move on.",
    "- Never skip, disable or loosen a test to get checks green. Never rewrite the branch's history.",
    reply
      ? "- You may answer the review threads you handled with gh, as the user. End each reply with a line that reads: via Pipoca"
      : "- Never comment, review or reply on GitHub as the user. Report in this chat instead.",
  ].join("\n");
}

export function viewOf(
  watch: Pick<Watch, "id" | "url" | "autoFix">,
  state: PullState,
): PullWatch {
  const latest = new Map<string, Remark["kind"]>();

  for (const { author, kind } of state.remarks) {
    if (kind === "approved" || kind === "changes_requested") {
      latest.set(author, kind);
    }
  }

  const count = (status: string) =>
    state.checks.filter((check) => check.status === status).length;

  return {
    id: watch.id,
    url: state.url === "" ? watch.url : state.url,
    title: state.title,
    state: state.state,
    checks: {
      passed: count("passed"),
      failed: count("failed"),
      pending: count("pending"),
    },
    conflicts: state.conflicts,
    changesRequested: [...latest.values()].includes("changes_requested"),
    autoFix: watch.autoFix,
    error: null,
  };
}
