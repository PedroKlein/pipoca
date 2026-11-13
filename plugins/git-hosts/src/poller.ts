import { owners, type ServerContext } from "@pipoca/plugins";
import type { gitHosts } from "../plugin";
import { hostCall, HostRefused } from "./github";
import type { Hosts } from "./hosts";
import { type Answers, pullStateOf } from "./pulls";
import { newsOf, rules, viewOf, type Watch, type WatchStore } from "./watch";

export interface Account {
  readonly host: string;
  readonly login: string;
  readonly token: string;
}

type Outcome = "news" | "quiet" | "failed";

interface Poller {
  // Polls one watch soon, such as one just added.
  readonly soon: (id: string) => void;
  // Polls one watch now, such as after a merge.
  readonly poll: (id: string) => Promise<void>;
}

// Polls every watched pull request with its person's token, or team work's
// with the team's bot (ADR 0071), and tells its Session what changed
// (ADR 0051). News goes through the Session's outbox, so a Session that is
// offline hears it when it is back.
export function startPoller(
  watches: WatchStore,
  hosts: Hosts,
  // The account to poll a watch as, or why there is none.
  accountOf: (watch: Watch) => Account | string,
  {
    sessions,
    routes,
    config,
    schedule,
    clock,
    log,
    network,
  }: Pick<
    ServerContext<typeof gitHosts>,
    "sessions" | "routes" | "config" | "schedule" | "clock" | "log" | "network"
  >,
): Poller {
  const answers: Answers = new Map();

  const deliver = (
    watch: Watch,
    news: readonly string[],
    ends: boolean,
    reply: boolean,
  ): void => {
    const lines = news.map((line) => `- ${line}`);

    if (lines.length === 0) {
      return;
    }

    const proposes = sessions.get(watch.sessionId)?.proposes === true;
    const brief = watch.briefed ? "" : `\n\n${rules(reply, proposes)}`;

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
    const account = accountOf(watch);

    if (host === undefined || typeof account === "string") {
      watches.update(watch.id, {
        view: {
          ...watch.view,
          error:
            typeof account === "string"
              ? account
              : `${watch.host} isn't one of the git hosts.`,
        },
      });

      return "quiet";
    }

    const state = await pullStateOf(
      hostCall(host, network, {
        owner: owners.fromSql(watch.userId),
        action: "pull request watching",
      }),
      account.token,
      watch,
      answers,
    );

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

    // Team work never replies as a person (ADR 0071).
    const reply =
      watch.userId !== null && watches.preferences(watch.userId).reply;

    if (watch.autoFix) {
      deliver(
        watch,
        [...news, ...(watch.seen === null ? [] : final)],
        ends,
        reply,
      );
    }

    if (ends) {
      watches.remove(watch.id);
    }

    if (changed || ends) {
      routes.topic("pull-requests");
    }

    return news.length > 0 ? "news" : "quiet";
  };

  const attempt = async (watch: Watch): Promise<Outcome> =>
    poll(watch).catch((failure: unknown) => {
      if (failure instanceof HostRefused) {
        watches.update(watch.id, {
          view: { ...watch.view, error: failure.message },
        });
      }

      log("pull request poll failed", {
        url: watch.url,
        error: failure instanceof Error ? failure.message : String(failure),
      });

      return "failed";
    });

  // One poll of a watch at a time, so two never send the same news.
  const inFlight = new Map<string, Promise<Outcome>>();

  const guarded = async (id: string): Promise<Outcome> => {
    const run = (inFlight.get(id) ?? Promise.resolve("quiet")).then(
      async () => {
        const watch = watches.get(id);

        return watch === undefined ? "quiet" : attempt(watch);
      },
    );

    inFlight.set(id, run);

    try {
      return await run;
    } finally {
      if (inFlight.get(id) === run) {
        inFlight.delete(id);
      }
    }
  };

  schedule.every(
    "poll",
    () => config.get().pollSeconds * 1000,
    async () => {
      const started = clock.now();
      const due = watches.all();
      const outcomes = [];

      for (const { id } of due) {
        outcomes.push(await guarded(id));
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
    await guarded(id);
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
