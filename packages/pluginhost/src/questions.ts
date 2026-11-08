import type {
  QuestionDesk,
  QuestionKeeper,
  Questions,
  ReplyPlace,
} from "@pipoca/plugins";
import type { Log } from "@pipoca/protocol";

// The questions that wait for an answer as a message (ADR 0076): one plugin
// keeps them, and each plugin that publishes events posts them back where
// one of its events came from. A plugin's throw counts as nothing done.
export function questionBroker(log: Log): {
  readonly keep: (plugin: string, keeper: QuestionKeeper) => void;
  readonly keeper: () => string | undefined;
  readonly place: (plugin: string, place: ReplyPlace) => void;
  readonly desk: QuestionDesk;
  readonly questions: Questions;
} {
  let kept:
    { readonly plugin: string; readonly keeper: QuestionKeeper } | undefined;

  const places = new Map<string, ReplyPlace>();

  const failed = (plugin: string, call: string, error: unknown): void => {
    log("plugin call failed", {
      plugin,
      call,
      error: error instanceof Error ? error.message : String(error),
    });
  };

  const withKeeper = <T>(
    call: string,
    nothing: T,
    run: (keeper: QuestionKeeper) => T,
  ): T => {
    if (kept === undefined) {
      return nothing;
    }

    try {
      return run(kept.keeper);
    } catch (error) {
      failed(kept.plugin, call, error);

      return nothing;
    }
  };

  return {
    keep: (plugin, keeper) => {
      kept = { plugin, keeper };
    },
    keeper: () => kept?.plugin,
    place: (plugin, place) => {
      places.set(plugin, place);
    },
    desk: {
      post: async (question) => {
        const plugin = question.origin.event.slice(
          0,
          question.origin.event.indexOf("."),
        );

        const place = places.get(plugin);

        if (place === undefined) {
          return false;
        }

        try {
          return await place.post(question);
        } catch (error) {
          failed(plugin, "replies", error);

          return false;
        }
      },
    },
    questions: {
      wait: (sessionId, waiting) =>
        withKeeper("questions", false, (keeper) => {
          keeper.wait(sessionId, waiting);

          return true;
        }),
      answer: (id, reply) =>
        withKeeper("questions", false, (keeper) => keeper.answer(id, reply)),
      open: (sessionId) =>
        withKeeper("questions", [], (keeper) => keeper.open(sessionId)),
    },
  };
}
