import type {
  Delivery,
  PluginDestinations,
  Session,
  Sessions,
  Store,
} from "@pipoca/plugins";
import type { DeclaredDestination, Log } from "@pipoca/protocol";
import { Value } from "typebox/value";
import type { Delivered, RunOutcome } from "./model";
import type { Heard, Routine } from "./routine";

type Outcome = Delivery["outcome"];

interface Destination {
  readonly destination: DeclaredDestination;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly on: readonly Outcome[];
}

// The destinations the routine's results go to, each found among the ones
// enabled plugins declare by its type or by its name alone, with settings
// that fit it. An Error names the first that doesn't.
export function destinationsOf(
  routine: Routine,
  declared: readonly DeclaredDestination[],
): readonly Destination[] {
  return (routine.results ?? []).map((each, index) => {
    const exact = declared.find(({ type }) => type === each.to);

    const byName = declared.filter(
      ({ type }) => type.slice(type.indexOf(".") + 1) === each.to,
    );

    const destination = exact ?? (byName.length === 1 ? byName[0] : undefined);

    if (destination === undefined) {
      throw new Error(
        byName.length > 1
          ? `results.${String(index)}.to: name one of ${byName.map(({ type }) => type).join(", ")}`
          : `results.${String(index)}.to: no plugin that is on offers ${each.to}`,
      );
    }

    const settings = each.with ?? {};

    if (!Value.Check(destination.settings, settings)) {
      const [error] = Value.Errors(destination.settings, settings);
      const at = error?.instancePath.slice(1).replaceAll("/", ".") ?? "";

      throw new Error(
        `results.${String(index)}.with${at === "" ? "" : `.${at}`} ${error?.message ?? "doesn't fit"}`,
      );
    }

    return { destination, settings, on: each.on ?? ["done"] };
  });
}

interface Ended {
  readonly runId: string;
  readonly session: Session;
  readonly routine: Routine;
  readonly outcome: Outcome;
  readonly summary: string;
  readonly output?: Readonly<Record<string, unknown>>;
  readonly events: readonly Heard[];
}

interface ResultRow {
  readonly destination: string;
  readonly state: "sent" | "failed";
  readonly text: string;
  readonly url: string | null;
}

// The run as the engine keeps it.
interface EndedRun {
  readonly id: string;
  readonly session_id: string | null;
  readonly dry: number;
  readonly events: string | null;
  readonly output: string | null;
}

interface Results {
  // A run that started a Session sends its result where its routine says
  // when it ends, unless it was a dry run.
  readonly ended: (
    run: EndedRun,
    routine: Routine | undefined,
    outcome: RunOutcome,
    reason: string | null,
  ) => void;
  readonly of: (runId: string) => readonly Delivered[];
}

const endedAs: Readonly<Partial<Record<RunOutcome, Outcome>>> = {
  ok: "done",
  nothing: "nothing",
  blocked: "blocked",
  failed: "failed",
  stopped: "stopped",
};

// Delivers runs' results where their routines say (ADR 0075), and records
// what each destination wrote or why it failed.
export function results(context: {
  readonly destinations: PluginDestinations;
  readonly sessions: Pick<Sessions, "get">;
  readonly store: Store;
  readonly clock: { readonly now: () => number };
  readonly log: Log;
  readonly changed: () => void;
}): Results {
  const { store, log } = context;

  const recorded = (runId: string, row: ResultRow): void => {
    store.run(
      "insert into routines_results (run_id, destination, state, text, url, delivered_at) values (?, ?, ?, ?, ?, ?)",
      runId,
      row.destination,
      row.state,
      row.text,
      row.url,
      context.clock.now(),
    );

    context.changed();
  };

  const deliver = async (ended: Ended): Promise<void> => {
    let wanted: readonly Destination[];

    try {
      wanted = destinationsOf(
        ended.routine,
        context.destinations.declared(),
      ).filter(({ on }) => on.includes(ended.outcome));
    } catch (error) {
      recorded(ended.runId, {
        destination: "",
        state: "failed",
        text: messageOf(error),
        url: null,
      });

      return;
    }

    const delivery: Delivery = {
      session: ended.session,
      routine: ended.routine.title,
      outcome: ended.outcome,
      summary: ended.summary,
      ...(ended.output !== undefined && { output: ended.output }),
      events: ended.events.map(({ type, fields }) => ({ type, fields })),
      text: textOf(ended),
    };

    await Promise.all(
      wanted.map(async ({ destination, settings }) => {
        try {
          const applied = await context.destinations.deliver(
            destination.type,
            settings,
            delivery,
          );

          recorded(ended.runId, {
            destination: destination.type,
            state: "sent",
            text: applied.text,
            url: applied.url ?? null,
          });

          log("routine result delivered", {
            id: ended.runId,
            destination: destination.type,
          });
        } catch (error) {
          recorded(ended.runId, {
            destination: destination.type,
            state: "failed",
            text: messageOf(error),
            url: null,
          });

          log("routine result not delivered", {
            id: ended.runId,
            destination: destination.type,
            error: messageOf(error),
          });
        }
      }),
    );
  };

  return {
    ended: (run, routine, outcome, reason) => {
      const session =
        run.session_id === null
          ? undefined
          : context.sessions.get(run.session_id);

      const as = endedAs[outcome];

      if (
        routine?.results === undefined ||
        routine.do.kind !== "session" ||
        session === undefined ||
        run.dry === 1 ||
        as === undefined
      ) {
        return;
      }

      void deliver({
        runId: run.id,
        session,
        routine,
        outcome: as,
        summary: reason ?? "",
        ...(run.output !== null && {
          output: JSON.parse(run.output) as Record<string, unknown>,
        }),
        events: JSON.parse(run.events ?? "[]") as Heard[],
      });
    },
    of: (runId: string): readonly Delivered[] =>
      store
        .all<ResultRow>(
          "select destination, state, text, url from routines_results where run_id = ? order by delivered_at, rowid",
          runId,
        )
        .map((row) => ({
          destination: row.destination,
          state: row.state,
          text: row.text,
          ...(row.url !== null && { url: row.url }),
        })),
  };
}

const outcomeWords: Readonly<Record<Outcome, string>> = {
  done: "Done",
  nothing: "Nothing to do",
  blocked: "Blocked",
  failed: "Failed",
  stopped: "Stopped",
};

function textOf(ended: Ended): string {
  const head = `${ended.routine.title}: ${outcomeWords[ended.outcome]}. ${ended.summary}`;

  return ended.output === undefined
    ? head
    : `${head}\n\n${JSON.stringify(ended.output, null, 2)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
