import type { ServerContext } from "@pipoca/plugins";
import type { routines } from "../plugin";
import type { Proposal, ProposalState } from "./model";
import type { Allowed } from "./routine";

type Context = Pick<
  ServerContext<typeof routines>,
  "store" | "sessions" | "actions" | "blobs" | "clock" | "log"
>;

// A run that proposes, as its proposals need it.
export interface ProposingRun {
  readonly id: string;
  readonly sessionId: string;
  readonly dryRun: boolean;
}

export interface Proposed {
  readonly action: string;
  readonly input: unknown;
  // The blob of a git bundle of the run's workspace branch.
  readonly commits?: string;
}

export interface Proposals {
  // Records what the run proposes, or refuses it when the routine doesn't
  // allow it or the run has used up its maximum.
  readonly propose: (
    run: ProposingRun,
    allowed: readonly Allowed[],
    proposed: Proposed,
  ) => Proposal;
  readonly of: (runId: string) => readonly Proposal[];
  // Applies what the runs proposed, once their turn ended: a dry run's are
  // shown only, and those that need approval wait for a person.
  readonly settle: (
    runs: readonly ProposingRun[],
    allowed: readonly Allowed[],
  ) => Promise<void>;
  // A person approves or rejects a waiting proposal, by id when Pipoca
  // knows them, and why when it is rejected.
  readonly decide: (
    run: ProposingRun,
    id: string,
    approved: boolean,
    by: string | null,
    why?: string,
  ) => Promise<Proposal>;
}

interface Row {
  readonly id: string;
  readonly run_id: string;
  readonly action: string;
  readonly title: string;
  readonly input: string;
  readonly commits: string | null;
  readonly state: ProposalState;
  readonly result: string | null;
  readonly url: string | null;
  readonly proposed_at: number;
}

// What a run proposes to write outside, kept until its turn ends and then
// applied through the plugin that offers the action (ADR 0076).
// A proposal that needs approval asks for it as a question in the run's
// Session, which ask returns the id of, when it could.
export function proposals(
  context: Context,
  opened: (runId: string, url: string) => void,
  ask: (run: ProposingRun, proposal: Proposal) => string | undefined,
): Proposals {
  const { store, clock, log } = context;

  const rows = (runId: string): Row[] =>
    store.all<Row>(
      "select * from routines_proposals where run_id = ? order by proposed_at, rowid",
      runId,
    );

  const view = (row: Row): Proposal => ({
    id: row.id,
    action: row.action,
    title: row.title,
    input: JSON.parse(row.input) as unknown,
    state: row.state,
    result: row.result,
    url: row.url,
    proposedAt: new Date(row.proposed_at).toISOString(),
  });

  const rowOf = (id: string): Row | undefined =>
    store.get<Row>("select * from routines_proposals where id = ?", id);

  const set = (
    id: string,
    state: ProposalState,
    result: string | null = null,
    url: string | null = null,
  ): void => {
    store.run(
      "update routines_proposals set state = ?, result = ?, url = ?, ended_at = ? where id = ?",
      state,
      result,
      url,
      state === "waiting" ? null : clock.now(),
      id,
    );
  };

  // A bundle no proposal still needs is dropped.
  const release = async (row: Row): Promise<void> => {
    if (row.commits === null) {
      return;
    }

    const kept = store.get<{ id: string }>(
      "select id from routines_proposals where commits = ? and state in ('proposed', 'waiting') limit 1",
      row.commits,
    );

    if (kept === undefined) {
      await context.blobs.remove(row.commits);
    }
  };

  const apply = async (run: ProposingRun, row: Row): Promise<void> => {
    const session = context.sessions.get(run.sessionId);

    try {
      if (session === undefined) {
        throw new Error("the run's Session is gone");
      }

      const commits =
        row.commits === null
          ? undefined
          : await context.blobs.bytes(row.commits);

      if (row.commits !== null && commits === undefined) {
        throw new Error("the commits never reached the server");
      }

      const applied = await context.actions.apply(
        row.action,
        JSON.parse(row.input),
        { session, ...(commits !== undefined && { commits }) },
      );

      set(row.id, "applied", applied.text, applied.url ?? null);

      if (row.commits !== null && applied.url !== undefined) {
        opened(run.id, applied.url);
      }

      log("routine proposal applied", { id: row.id, action: row.action });
    } catch (error) {
      set(row.id, "failed", messageOf(error));

      log("routine proposal failed", {
        id: row.id,
        action: row.action,
        error: messageOf(error),
      });
    }

    await release(row);
  };

  return {
    propose: (run, allowed, { action, input, commits }) => {
      const found = allowed.find(
        (each) => each.name === action || each.action.type === action,
      );

      const counted = rows(run.id).filter(
        (row) =>
          row.action === found?.action.type &&
          !["refused", "rejected", "failed"].includes(row.state),
      );

      // A pull request proposed again updates the one the run opened.
      const again = found?.action.commits === true && counted.length > 0;

      const refusal = (() => {
        if (found === undefined) {
          return `the routine doesn't allow ${action}; it allows ${allowed.map(({ name }) => name).join(", ") || "nothing"}`;
        }

        if (!again && counted.length >= found.max) {
          return `the routine allows ${found.name} at most ${String(found.max)} ${found.max === 1 ? "time" : "times"} a run`;
        }

        if (found.action.commits === true && commits === undefined) {
          return `${found.name} needs the commits on the workspace branch`;
        }

        return undefined;
      })();

      const row: Row = {
        id: Bun.randomUUIDv7(),
        run_id: run.id,
        action: found?.action.type ?? action,
        title: found?.action.title ?? action,
        input: JSON.stringify(input ?? null),
        commits: refusal === undefined ? (commits ?? null) : null,
        state: refusal === undefined ? "proposed" : "refused",
        result: refusal ?? null,
        url: null,
        proposed_at: clock.now(),
      };

      store.run(
        "insert into routines_proposals (id, run_id, action, title, input, commits, state, result, proposed_at, ended_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        row.id,
        row.run_id,
        row.action,
        row.title,
        row.input,
        row.commits,
        row.state,
        row.result,
        row.proposed_at,
        refusal === undefined ? null : row.proposed_at,
      );

      log("routine run proposed", {
        runId: run.id,
        action: row.action,
        state: row.state,
      });

      return view(row);
    },
    of: (runId) => rows(runId).map(view),
    settle: async (runs, allowed) => {
      for (const run of runs) {
        for (const row of rows(run.id).filter(
          ({ state }) => state === "proposed",
        )) {
          const approve = allowed.find(
            ({ action }) => action.type === row.action,
          )?.approve;

          if (run.dryRun) {
            set(row.id, "shown", "a dry run's proposals aren't applied");
            await release(row);
          } else if (approve === true) {
            set(row.id, "waiting");

            store.run(
              "update routines_proposals set question_id = ? where id = ?",
              ask(run, view({ ...row, state: "waiting" })) ?? null,
              row.id,
            );
          } else {
            await apply(run, row);
          }
        }
      }
    },
    decide: async (run, id, approved, by, why = "rejected by a person") => {
      const row = rowOf(id);

      if (row?.run_id !== run.id || row.state !== "waiting") {
        throw new Error("no proposal of this run waits for approval");
      }

      store.run(
        "update routines_proposals set decided_by = ? where id = ?",
        by,
        id,
      );

      log("routine proposal decided", { id, approved, by });

      if (approved) {
        await apply(run, row);
      } else {
        set(id, "rejected", why);
        await release(row);
      }

      const after = rowOf(id);

      return view(after ?? row);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
