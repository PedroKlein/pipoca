import type { ServerContext } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";
import { HostRefused } from "./github";
import type { Hosts } from "./hosts";
import { type Answers, pullStateOf } from "./pulls";
import { newsOf, rules, viewOf, type Watch, type WatchStore } from "./watch";

export interface Account {
  readonly host: string;
  readonly login: string;
  readonly token: string;
}

export interface Poller {
  // Polls one watch soon, such as one just added.
  readonly soon: (id: string) => void;
  // Polls one watch now, such as after a merge.
  readonly poll: (id: string) => Promise<void>;
}

// Polls every watched pull request with its person's token and tells its
// Session what changed (ADR 0051). News goes through the Session's outbox,
// so a Session that is offline hears it when it is back.
export function startPoller(
  watches: WatchStore,
  hosts: Hosts,
  accounts: (userId: string) => readonly Account[],
  {
    sessions,
    routes,
    config,
    schedule,
    clock,
    log,
  }: Pick<
    ServerContext<typeof gitHosts>,
    "sessions" | "routes" | "config" | "schedule" | "clock" | "log"
  >,
): Poller {
  const answers: Answers = new Map();

  const deliver = (
    watch: Watch,
    news: readonly string[],
    ends: boolean,
  ): void => {
    const lines = news.map((line) => `- ${line}`);

    if (lines.length === 0) {
      return;
    }

    const brief = watch.briefed
      ? ""
      : `\n\n${rules(watches.preferences(watch.userId).reply)}`;

    // A pull request that ended needs no fix, so its news waits for the
    // Session's next turn.
    const sent = sessions.send(watch.sessionId, {
      text: `News on ${watch.url}:\n${lines.join("\n")}${brief}`,
      turn: !ends,
      notice: { kind: "pull_request", data: { url: watch.url, news } },
    });

    if (sent === "queued") {
      watches.update(watch.id, { briefed: true });

      log("pull request news sent", {
        sessionId: watch.sessionId,
        url: watch.url,
        items: lines.length,
      });

      return;
    }

    watches.remove(watch.id);

    log("stopped watching for a Session that is gone", {
      sessionId: watch.sessionId,
      url: watch.url,
    });
  };

  const poll = async (watch: Watch): Promise<"news" | "quiet"> => {
    const session = sessions.get(watch.sessionId);

    if (session?.archivedAt !== null) {
      watches.remove(watch.id);
      routes.topic("pull-requests");

      return "quiet";
    }

    const host = hosts.get(watch.host);

    const account = accounts(watch.userId).find(
      ({ host: name }) => name === watch.host,
    );

    if (host === undefined || account === undefined) {
      watches.update(watch.id, {
        view: { ...watch.view, error: `Connect ${watch.host} to watch it.` },
      });

      return "quiet";
    }

    const state = await pullStateOf(host, account.token, watch, answers);
    const { news, seen } = newsOf(watch.seen, state, account.login);
    const ends = state.state !== "open";

    const final = {
      open: [],
      merged: ["It merged."],
      closed: ["It was closed."],
    }[state.state];

    const view = viewOf(watch, state);
    const changed = JSON.stringify(view) !== JSON.stringify(watch.view);

    watches.update(watch.id, { seen, view });

    if (watch.autoFix) {
      deliver(watch, [...news, ...(watch.seen === null ? [] : final)], ends);
    }

    if (ends) {
      watches.remove(watch.id);
    }

    if (changed || ends) {
      routes.topic("pull-requests");
    }

    return news.length > 0 ? "news" : "quiet";
  };

  const guarded = async (watch: Watch): Promise<"news" | "quiet" | "failed"> =>
    poll(watch).catch((failure: unknown) => {
      if (!(failure instanceof HostRefused)) {
        throw failure;
      }

      watches.update(watch.id, {
        view: { ...watch.view, error: failure.message },
      });

      log("pull request poll failed", {
        url: watch.url,
        error: failure.message,
      });

      return "failed";
    });

  schedule.every(
    "poll",
    () => config.get().pollSeconds * 1000,
    async () => {
      const started = clock.now();
      const due = watches.all();
      const outcomes = [];

      for (const watch of due) {
        outcomes.push(await guarded(watch));
      }

      if (due.length > 0) {
        log("pull requests polled", {
          polled: due.length,
          withNews: outcomes.filter((each) => each === "news").length,
          failed: outcomes.filter((each) => each === "failed").length,
          ms: clock.now() - started,
        });
      }
    },
  );

  const pollOne = async (id: string): Promise<void> => {
    const watch = watches.get(id);

    if (watch !== undefined) {
      await guarded(watch);
    }
  };

  schedule.on("watched:", async (_payload, key) => {
    await pollOne(key.slice("watched:".length));
  });

  return {
    soon: (id) => {
      schedule.at(`watched:${id}`, clock.now());
    },
    poll: pollOne,
  };
}
