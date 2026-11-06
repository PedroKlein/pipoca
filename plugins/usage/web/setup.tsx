import { usage } from "../plugin";
import { useLoaded, useApi } from "@pipoca/plugins/web";
import {
  Button,
  buttonClass,
  Cell,
  cardClass,
  cn,
  EmptyState,
  ErrorText,
  Field,
  Page,
  Section,
  Table,
  TextInput,
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
    <Page
      title="Budgets"
      description="What team work spends through the team's keys each month. Budgets only warn: at 80% and 100% Pipoca tells admins, and the person whose cap it is. Work keeps running."
    >
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
                <TextInput
                  name="team"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={totals.budgets.team ?? ""}
                />
              </Field>
              <Field
                label="Each person's cap"
                hint="Dollars a month of team work. Empty for none."
              >
                <TextInput
                  name="person"
                  type="number"
                  min="0.01"
                  step="0.01"
                  defaultValue={totals.budgets.person ?? ""}
                />
              </Field>
            </div>
            <div className="flex items-center gap-3">
              <Button variant="primary" type="submit">
                Save
              </Button>
              <p role="status" className="text-caption">
                {error !== undefined ? (
                  <ErrorText inline size="inherit">
                    {error}
                  </ErrorText>
                ) : (
                  saved && <span className="text-fg-dim">Saved</span>
                )}
              </p>
            </div>
          </form>
        </Section>
      )}
    </Page>
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
        className={buttonClass()}
      >
        Download CSV
      </a>
      <a
        href="/api/ext/usage/calls?format=csv"
        download
        className={buttonClass()}
      >
        Model calls CSV
      </a>
    </>
  );

  return (
    <Page
      title="Audit log"
      description="Who started, stopped and archived team work, and each model call on the team's keys. The CSVs have all of it."
      actions={download}
    >
      {entries?.length === 0 && (
        <EmptyState>
          Nothing yet. Team work shows up here as it happens.
        </EmptyState>
      )}
      {entries !== undefined && entries.length > 0 && (
        <Table label="Audit log" columns={["When", "Who", "What", "Session"]}>
          {entries.slice(0, shownEntries).map((entry, index) => (
            <tr key={`${entry.at}:${String(index)}`}>
              <Cell className="whitespace-nowrap text-fg-dim tabular-nums">
                {new Date(entry.at).toLocaleString()}
              </Cell>
              <Cell>{who(entry.actor)}</Cell>
              <Cell>
                {entry.action}
                {entry.detail !== null && (
                  <span className="ml-1.5 font-mono text-mono-sm text-fg-dim">
                    {entry.detail}
                  </span>
                )}
              </Cell>
              <Cell>
                <a
                  href={`#${entry.sessionId}`}
                  className="font-mono text-mono-sm text-fg-dim hover:text-fg"
                >
                  {entry.sessionId.slice(0, 8)}
                </a>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
    </Page>
  );
}
