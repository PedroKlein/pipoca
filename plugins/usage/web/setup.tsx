import { usage } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import {
  Button,
  Card,
  cardClass,
  cn,
  Field,
  fieldClass,
  PageTitle,
  Section,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { Spend, type Totals } from "./spend";

interface AuditEntry {
  readonly at: string;
  readonly actor: string | null;
  readonly sessionId: string;
  readonly action: string;
  readonly detail: string | null;
}

// The team's monthly budget and each person's cap, which only warn
// (ADR 0066).
export function Budgets(): ReactElement {
  const api = useApi(usage);

  const { value: totals, reload } = useLoaded(
    async () => api.get<Totals>("totals"),
    "totals",
    { changes: ["totals"] },
  );

  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const amount = (name: string): number | null => {
      const value = form.get(name);

      return typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : null;
    };

    setSaved(false);

    api
      .put("budgets", {
        team: amount("team"),
        person: amount("person"),
      })
      .then(() => {
        setError(undefined);
        setSaved(true);
        reload();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <>
      <PageTitle description="What team work spends through the team's keys each month. Budgets only warn: at 80% and 100% Pipoca tells admins, and the person whose cap it is. Work keeps running.">
        Budgets
      </PageTitle>
      <Spend />
      {totals !== undefined && (
        <Section title="Each month">
          <form
            key={JSON.stringify(totals.budgets)}
            onSubmit={submit}
            className={cn(cardClass, "flex flex-col gap-4 p-5")}
          >
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <Field
                label="Team budget"
                hint="Dollars a month. Empty for none."
              >
                <input
                  name="team"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={totals.budgets.team ?? ""}
                  className={fieldClass}
                />
              </Field>
              <Field
                label="Each person's cap"
                hint="Dollars a month of team work. Empty for none."
              >
                <input
                  name="person"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={totals.budgets.person ?? ""}
                  className={fieldClass}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="primary" type="submit">
                Save
              </Button>
              <p role="status" className="text-caption">
                {error !== undefined ? (
                  <span className="text-failed">{error}</span>
                ) : (
                  saved && <span className="text-fg-dim">Saved</span>
                )}
              </p>
            </div>
          </form>
        </Section>
      )}
    </>
  );
}

const shownEntries = 100;

// Who started, stopped and archived team work, and each use of the team's
// key (ADR 0066).
export function AuditLog(): ReactElement {
  const api = useApi(usage);

  const { value: entries } = useLoaded(
    async () => api.get<readonly AuditEntry[]>("audit"),
    "audit",
    { changes: ["audit"] },
  );

  const { value: teammates = [] } = useLoaded(
    async () => api.get<readonly { id: string; name: string }[]>("/api/people"),
    "teammates",
  );

  const who = (actor: string | null): string => {
    if (actor === null) {
      return "Pi";
    }

    const [kind, id = ""] = actor.split(":");

    return kind === "user"
      ? (teammates.find((each) => each.id === id)?.name ?? id)
      : actor;
  };

  const download = (
    <>
      <a
        href="/api/ext/usage/audit?format=csv"
        download
        className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:bg-hover"
      >
        Download CSV
      </a>
      <a
        href="/api/ext/usage/calls?format=csv"
        download
        className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:bg-hover"
      >
        Model calls CSV
      </a>
    </>
  );

  return (
    <>
      <PageTitle
        description="Who started, stopped and archived team work, and each model call on the team's keys. The CSVs have all of it."
        actions={download}
      >
        Audit log
      </PageTitle>
      {entries?.length === 0 && (
        <p className="rounded-lg border border-dashed border-line-strong p-5 text-ui text-fg-dim">
          Nothing yet. Team work shows up here as it happens.
        </p>
      )}
      {entries !== undefined && entries.length > 0 && (
        <Card padding="none" className="relative overflow-x-auto">
          <table aria-label="Audit log" className="w-full text-left text-label">
            <thead className="text-caption text-fg-dim">
              <tr className="border-b border-line">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Who</th>
                <th className="px-3 py-2 font-medium">What</th>
                <th className="px-3 py-2 font-medium">Session</th>
              </tr>
            </thead>
            <tbody>
              {entries.slice(0, shownEntries).map((entry, index) => (
                <tr
                  key={`${entry.at}:${String(index)}`}
                  className="border-b border-line last:border-b-0"
                >
                  <td className="px-3 py-2 whitespace-nowrap text-fg-dim tabular-nums">
                    {new Date(entry.at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{who(entry.actor)}</td>
                  <td className="px-3 py-2">
                    {entry.action}
                    {entry.detail !== null && (
                      <span className="ml-1.5 font-mono text-mono-sm text-fg-dim">
                        {entry.detail}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <a
                      href={`#${entry.sessionId}`}
                      className="font-mono text-mono-sm text-fg-dim hover:text-fg"
                    >
                      {entry.sessionId.slice(0, 8)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
