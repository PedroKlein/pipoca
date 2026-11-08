import type { TypedClient } from "@pipoca/plugins";
import { useLoaded } from "@pipoca/plugins/web";
import { Badge } from "@pipoca/ui";
import type { DeclaredCheck, DeclaredDestination } from "@pipoca/protocol";
import type { ReactElement } from "react";
import type { RoutineDetail, Run, TriggerNote } from "../src/model";

// What a routine's watches, collecting triggers, checks and results do, as
// plain lines (ADR 0075).
export function TriggerLines({
  routine,
}: {
  readonly routine: RoutineDetail;
}): ReactElement | null {
  const when = routine.routine?.when ?? [];
  const results = routine.routine?.results ?? [];

  const noteOf = (notes: readonly TriggerNote[] | undefined, at: number) =>
    notes?.find(({ trigger }) => trigger === at);

  const lines = when.flatMap((each, at) => {
    const found: string[] = [];

    if (each.kind === "watch") {
      const fetched = noteOf(routine.watches, at);

      found.push(
        `Watches ${each.url}${each.path === undefined ? "" : ` at ${each.path}`} every ${each.every}.${
          fetched === undefined
            ? ""
            : ` Fetched ${new Date(fetched.at).toLocaleString()}${fetched.error === undefined ? "" : `: ${fetched.error}`}.`
        }`,
      );
    }

    if (each.kind === "event" && each.collect !== undefined) {
      found.push(
        `Gathers ${each.event} and runs once on ${each.collect.cron} with what it gathered.`,
      );
    }

    if (
      (each.kind === "event" || each.kind === "watch") &&
      each.check !== undefined
    ) {
      const checked = noteOf(routine.checks, at);

      found.push(
        `Checks first with ${typeof each.check === "string" ? "a script" : each.check.use}.${
          checked === undefined
            ? ""
            : ` Last ${checked.passed === true ? "passed" : "said no"} ${new Date(checked.at).toLocaleString()}${checked.error === undefined ? "" : `: ${checked.error}`}.`
        }`,
      );
    }

    return found;
  });

  if (results.length > 0) {
    lines.push(
      `Results go to ${results.map(({ to }) => to).join(", ")} when a run ends.`,
    );
  }

  if (lines.length === 0) {
    return null;
  }

  return (
    <ul className="flex flex-col gap-1 text-ui text-fg-dim">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

export function RunResults({
  run,
}: {
  readonly run: Run;
}): ReactElement | null {
  if (run.results === undefined || run.results.length === 0) {
    return null;
  }

  return (
    <ul aria-label="Results" className="ml-6 flex flex-col gap-1 py-1">
      {run.results.map((result, index) => (
        <li
          key={`${result.destination}-${String(index)}`}
          className="flex min-w-0 items-center gap-2"
        >
          <Badge state={result.state === "sent" ? "done" : "failed"}>
            {result.state === "sent" ? "Sent" : "Not sent"}
          </Badge>
          <span className="text-fg-dim">{result.destination}</span>
          {result.url === undefined ? (
            <span className="min-w-0 truncate text-fg">{result.text}</span>
          ) : (
            <a href={result.url} className="min-w-0 truncate text-fg underline">
              {result.text}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

// Where results can go and which checks a trigger can use, with what each
// takes.
export function DeclaredExtras({
  api,
}: {
  readonly api: TypedClient;
}): ReactElement | null {
  const destinations = useLoaded(
    async () => api.get<DeclaredDestination[]>("destinations"),
    "destinations",
  ).value;

  const checks = useLoaded(
    async () => api.get<DeclaredCheck[]>("checks"),
    "checks",
  ).value;

  const listed = [
    {
      summary:
        'Where results can go, as "results": [{ "to": type, "with": settings }]',
      items: destinations ?? [],
    },
    {
      summary: 'Checks a trigger can use, as "check": { "use": type }',
      items: checks ?? [],
    },
  ].filter(({ items }) => items.length > 0);

  return (
    <>
      {listed.map(({ summary, items }) => (
        <details key={summary} className="text-label text-fg-dim">
          <summary className="cursor-pointer">{summary}</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.type}>
                <code className="text-fg">{item.type}</code>: {item.title}
                {item.description !== undefined && ` ${item.description}`}
                {item.settings !== undefined && (
                  <span className="block">
                    Settings: {settingNames(item.settings).join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </>
  );
}

function settingNames(schema: Readonly<Record<string, unknown>>): string[] {
  const { properties } = schema;

  return typeof properties === "object" && properties !== null
    ? Object.keys(properties)
    : [];
}
