import { href as pageHref, useApi, useLoaded } from "@pipoca/plugins/web";
import type { Environment } from "@pipoca/protocol";
import { Badge, type BadgeState } from "@pipoca/ui";
import type { ReactElement } from "react";
import { routines } from "../plugin";
import type { RoutineView, RunOutcome } from "../src/model";

export const changes = ["routines"];

// The address of a path inside the routines page, "" for the page.
export const pageAt = (path: string): string => pageHref(routines, path);

// A person's own routines, or the team's, which anyone on the team makes
// and changes (ADR 0067). The team's routes and pages start with team/.
export interface Scope {
  readonly prefix: "" | "team/";
}

export const yours: Scope = { prefix: "" };
export const teams: Scope = { prefix: "team/" };

// A group's page is group:<name> inside its owner's, which no routine's
// name can be.
export const groupPage = "group:";

export function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const outcomes: Readonly<
  Record<RunOutcome, { readonly state: BadgeState; readonly label: string }>
> = {
  running: { state: "working", label: "Running" },
  waiting: { state: "waiting", label: "Waiting for a person" },
  queued: { state: "waiting", label: "Queued" },
  ok: { state: "done", label: "Done" },
  nothing: { state: "offline", label: "Nothing to do" },
  stopped: { state: "offline", label: "Stopped" },
  failed: { state: "failed", label: "Failed" },
  skipped: { state: "offline", label: "Skipped" },
  blocked: { state: "failed", label: "Blocked" },
};

export function OutcomeBadge({
  outcome,
}: {
  readonly outcome: RunOutcome;
}): ReactElement {
  const { state, label } = outcomes[outcome];

  return <Badge state={state}>{label}</Badge>;
}

export function summaryOf(routine: RoutineView): string {
  if (routine.error !== undefined) {
    return "Doesn't load";
  }

  if (routine.paused !== null) {
    return routine.pausedUntil === null
      ? routine.paused
      : `${routine.paused} Resumes ${new Date(routine.pausedUntil).toLocaleString()}.`;
  }

  return routine.nextAt === null
    ? "Nothing scheduled"
    : `Next run ${new Date(routine.nextAt).toLocaleString()}`;
}

// The Environments a routine of a person's own, or of the team's, may name.
// Undefined while loading or when the list can't load.
export function useEnvironments(
  team: boolean,
): readonly Environment[] | undefined {
  const api = useApi(routines);

  return useLoaded(
    async () =>
      api
        .get<readonly Environment[]>(
          `/api/environments${team ? "?scope=team" : ""}`,
        )
        .catch(() => undefined),
    `environments ${String(team)}`,
    { topics: ["environments"] },
  ).value;
}
