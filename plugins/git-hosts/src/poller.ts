import type { ServerPluginContext } from "@pipoca/plugins";
import { HostRefused } from "./github";
import type { HostStore } from "./hosts";
import { type Answers, pullStateOf } from "./pulls";
import { newsOf, rules, viewOf, type Watch, type WatchStore } from "./watch";

const defaultPollSeconds = 60;
const tickMs = 1000;

interface Account {
  readonly host: string;
  readonly login: string;
  readonly token: string;
}

export interface Poller {
  // Polls one watch now, such as one just added.
  readonly poll: (id: string) => Promise<void>;
}

// Polls every watched pull request with its person's token and tells its
// Session what changed (ADR 0051).
export function startPoller(
  watches: WatchStore,
  hosts: HostStore,
  accounts: (userId: string) => readonly Account[],
  {
    sessions,
    changes,
    settings,
    signal,
    log,
  }: Pick<
    ServerPluginContext,
    "sessions" | "changes" | "settings" | "signal" | "log"
  >,
): Poller {
  const answers: Answers = new Map();

  const deliver = (watch: Watch, news: readonly string[], ends: boolean) => {
    const waiting = watch.pending === null ? [] : [watch.pending];
    const lines = [...waiting, ...news.map((line) => `- ${line}`)];

    if (lines.length === 0) {
      return;
    }

    const brief = watch.briefed
      ? ""
      : `\n\n${rules(watches.preferences(watch.userId).reply)}`;

    const text = `News on ${watch.url}:\n${lines.join("\n")}${brief}`;
    const notice = { kind: "pull_request", data: { url: watch.url, news } };

    const sent = ends
      ? sessions.notify(watch.sessionId, text, "plugin:git-hosts", notice)
      : sessions.send(watch.sessionId, text, "plugin:git-hosts", notice);

    if (sent.ok) {
      watches.update(watch.id, { briefed: true, pending: null });

      log("pull request news sent", {
        sessionId: watch.sessionId,
        url: watch.url,
        items: lines.length,
      });

      return;
    }

    if (sent.reason === "offline") {
      watches.update(watch.id, { pending: lines.join("\n") });

      return;
    }

    watches.remove(watch.id);

    log("stopped watching for a Session that is gone", {
      sessionId: watch.sessionId,
      url: watch.url,
      reason: sent.reason,
    });
  };

  const poll = async (watch: Watch): Promise<"news" | "quiet"> => {
    const session = sessions.get(watch.sessionId);
    if (session?.archivedAt !== null) {
      watches.remove(watch.id);

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

    if (changed) {
      changes.publish("pull-requests");
    }

    if (watch.autoFix) {
      deliver(watch, [...news, ...(watch.seen === null ? [] : final)], ends);
    }

    if (ends) {
      watches.remove(watch.id);
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

  // When each watch was last polled, so a change to pollSeconds applies at
  // the next second instead of after the old wait.
  const polledAt = new Map<string, number>();

  const pollEvery = (): number => {
    const { pollSeconds } = settings.get();

    return (
      (typeof pollSeconds === "number" && pollSeconds > 0
        ? pollSeconds
        : defaultPollSeconds) * 1000
    );
  };

  const tick = async (): Promise<void> => {
    const started = Date.now();

    const due = watches
      .all()
      .filter(({ id }) => started - (polledAt.get(id) ?? 0) >= pollEvery());

    const outcomes = [];

    for (const watch of due) {
      polledAt.set(watch.id, Date.now());
      outcomes.push(await guarded(watch));
    }

    if (due.length > 0) {
      log("pull requests polled", {
        polled: due.length,
        withNews: outcomes.filter((each) => each === "news").length,
        failed: outcomes.filter((each) => each === "failed").length,
        ms: Date.now() - started,
      });
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    timer = setTimeout(() => {
      tick()
        .catch((failure: unknown) => {
          log("pull request polling failed", { error: String(failure) });
        })
        .finally(() => {
          if (!signal.aborted) {
            schedule();
          }
        });
    }, tickMs);
  };

  signal.addEventListener("abort", () => {
    clearTimeout(timer);
  });

  schedule();

  return {
    poll: async (id) => {
      const watch = watches.get(id);

      if (watch !== undefined) {
        polledAt.set(watch.id, Date.now());
        await guarded(watch);
      }
    },
  };
}
