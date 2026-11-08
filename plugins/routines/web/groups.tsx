import type { TypedClient } from "@pipoca/plugins";
import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Button,
  buttonClass,
  cn,
  Code,
  ErrorText,
  Field,
  FileButton,
  linkCardClass,
  Page,
  Section,
  Select,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { routines } from "../plugin";
import type { Group } from "../src/group";
import type { GroupDetail, GroupView, Imported } from "../src/model";
import {
  changes,
  failureOf,
  groupPage,
  OutcomeBadge,
  pageAt,
  type Scope,
  summaryOf,
  teams,
} from "./common";

interface Named {
  readonly id: string;
  readonly name: string;
}

// A scope's groups, for the Routines page.
export function Groups({
  scope,
  title,
}: {
  readonly scope: Scope;
  readonly title: string;
}): ReactElement | null {
  const api = useApi(routines);

  const list = useLoaded(
    async () => api.get<GroupView[]>(`${scope.prefix}groups`),
    `${scope.prefix}groups`,
    { changes },
  ).value;

  if (list === undefined || list.length === 0) {
    return null;
  }

  return (
    <Section title={title}>
      <ul className="flex flex-col gap-2">
        {list.map((group) => (
          <li key={group.name}>
            <a
              href={pageAt(`${scope.prefix}${groupPage}${group.name}`)}
              className={cn(
                linkCardClass,
                "flex min-w-0 flex-col px-3 py-2 text-ui",
              )}
            >
              <span className="truncate font-medium text-fg">
                {group.title}
              </span>
              <span className="truncate text-label text-fg-dim">
                {groupSummary(group)}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function groupSummary(group: GroupView): string {
  if (group.error !== undefined) {
    return "Its group.json doesn't load";
  }

  if (group.paused !== null) {
    return group.paused;
  }

  return `Spent today: ${group.spentToday.toFixed(2)}`;
}

// Takes a group another server exported, with its agents and workflows
// going into the Profile picked here.
export function ImportGroup({
  scope,
}: {
  readonly scope: Scope;
}): ReactElement {
  const api = useApi(routines);
  const [profile, setProfile] = useState("");
  const [failure, setFailure] = useState<string>();
  const profiles = useProfiles(api, scope);

  const take = (file: File): void => {
    setFailure(undefined);

    void api
      .raw(
        `${scope.prefix}groups/archives?profile=${encodeURIComponent(profile)}`,
        { method: "POST", body: file },
      )
      .then(async (response) => {
        const body = (await response.json()) as Imported & {
          readonly error?: string;
        };

        if (!response.ok) {
          setFailure(body.error ?? response.statusText);

          return;
        }

        location.hash = pageAt(`${scope.prefix}${groupPage}${body.name}`);
      }, setFailure);
  };

  return (
    <Section title="Import a group">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Profile for its agents"
          value={profile}
          onChange={(event) => {
            setProfile(event.target.value);
          }}
        >
          <option value="">Profile for its agents and workflows</option>
          {profiles.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
        <FileButton
          accept=".tar.gz,.tgz,application/gzip"
          disabled={profile === ""}
          onFiles={([file]) => {
            if (file !== undefined) {
              take(file);
            }
          }}
        >
          Import .tar.gz
        </FileButton>
      </div>
      <ErrorText size="inherit" className="text-ui">
        {failure === undefined ? undefined : failureOf(failure)}
      </ErrorText>
    </Section>
  );
}

function useProfiles(api: TypedClient, scope: Scope): readonly Named[] {
  return (
    useLoaded(
      async () =>
        api.get<Named[]>(
          `/api/profiles?scope=${scope === teams ? "team" : "mine"}`,
        ),
      `profiles-${scope.prefix}`,
      { topics: ["profiles"] },
    ).value ?? []
  );
}

// A routine's group, in its editor.
export function GroupPicker({
  api,
  scope,
  value,
  onChange,
}: {
  readonly api: TypedClient;
  readonly scope: Scope;
  readonly value: string;
  readonly onChange: (group: string) => void;
}): ReactElement | null {
  const list = useLoaded(
    async () => api.get<GroupView[]>(`${scope.prefix}groups`),
    `${scope.prefix}groups`,
    { changes },
  ).value;

  if (list === undefined || (list.length === 0 && value === "")) {
    return null;
  }

  return (
    <Field label="Group">
      <Select
        aria-label="Group"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">No group</option>
        {list.map((group) => (
          <option key={group.name} value={group.name}>
            {group.title}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// A group's board (ADR 0075): its routines, what waits on someone, its
// runs by piece of work, and what each routine cost and how often it
// succeeded.
export function GroupPage({
  scope,
  name,
}: {
  readonly scope: Scope;
  readonly name: string;
}): ReactElement {
  const api = useApi(routines);
  const [ask, asking] = useConfirm();
  const creating = name === "new";
  const [editing, setEditing] = useState(creating);
  const [failure, setFailure] = useState<string>();
  const path = `${scope.prefix}groups/${encodeURIComponent(name)}`;

  const { value: board, reload } = useLoaded(
    async () => (creating ? undefined : api.get<GroupDetail>(path)),
    `${scope.prefix}${groupPage}${name}`,
    { changes },
  );

  const download = (): void => {
    void api.raw(`${path}/archive`).then(async (response) => {
      if (!response.ok) {
        setFailure(response.statusText);

        return;
      }

      const link = document.createElement("a");
      link.href = URL.createObjectURL(await response.blob());
      link.download = `${name}.tar.gz`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  };

  return (
    <Page
      title={
        creating
          ? `New ${scope === teams ? "team " : ""}group`
          : (board?.title ?? name)
      }
      description={
        <a href={pageAt("")} className="hover:underline">
          All routines
        </a>
      }
    >
      {asking}
      {board !== undefined && (
        <div className="flex flex-col gap-3">
          <p className="text-ui text-fg-dim">
            {board.paused ?? "Running."} Spent today:{" "}
            {board.spentToday.toFixed(2)}
            {board.group?.budget === undefined
              ? ""
              : ` of its daily budget of ${String(board.group.budget.dailySpend)}`}
            . {rateText(board.successRate, board.succeeded + board.failed)}
          </p>
          <ErrorText size="inherit" className="text-ui">
            {board.error}
          </ErrorText>
          <div className="flex flex-wrap gap-2">
            <a
              href={pageAt(`${scope.prefix}new`)}
              className={buttonClass({ variant: "primary" })}
            >
              New routine
            </a>
            <Button
              onClick={() => {
                setEditing(!editing);
              }}
            >
              Edit
            </Button>
            <Button onClick={download}>Export</Button>
            {board.paused !== null && (
              <Button
                onClick={() => {
                  void api
                    .post(`${path}/resume`)
                    .then(reload, (error: unknown) => {
                      setFailure(failureOf(error));
                    });
                }}
              >
                Resume
              </Button>
            )}
            <Button
              variant="danger"
              onClick={() => {
                void ask({
                  title: `Delete the group “${board.title}” and its memory?`,
                  confirm: "Delete",
                  danger: true,
                }).then(async (yes) => {
                  if (!yes) {
                    return;
                  }

                  await api.delete(path).then(
                    () => {
                      location.hash = pageAt("");
                    },
                    (error: unknown) => {
                      setFailure(failureOf(error));
                    },
                  );
                });
              }}
            >
              Delete
            </Button>
          </div>
        </div>
      )}
      <ErrorText size="inherit" className="mt-3 text-ui">
        {failure}
      </ErrorText>
      {editing && (creating || board !== undefined) && (
        <GroupForm
          api={api}
          scope={scope}
          name={creating ? undefined : name}
          group={board?.group}
          onSaved={(saved) => {
            setEditing(false);

            if (creating) {
              location.hash = pageAt(`${scope.prefix}${groupPage}${saved}`);
            } else {
              reload();
            }
          }}
        />
      )}
      {board !== undefined && <Board scope={scope} board={board} />}
    </Page>
  );
}

function rateText(rate: number | null, ended: number): string {
  return rate === null
    ? "No run has ended yet."
    : `${String(Math.round(rate * 100))}% of ${String(ended)} ended runs succeeded.`;
}

function Board({
  scope,
  board,
}: {
  readonly scope: Scope;
  readonly board: GroupDetail;
}): ReactElement {
  const runHref = (routine: string, sessionId: string | null): string =>
    pageAt(`${scope.prefix}${routine}/${sessionId ?? ""}`);

  return (
    <>
      <Section title="Routines">
        {board.routines.length === 0 && (
          <p className="text-fg-dim">
            No routines yet. Pick this group in a routine&apos;s editor.
          </p>
        )}
        <ul className="flex flex-col gap-2">
          {board.routines.map((routine) => (
            <li key={routine.name}>
              <a
                href={pageAt(`${scope.prefix}${routine.name}`)}
                className={cn(
                  linkCardClass,
                  "flex min-w-0 items-center gap-3 px-3 py-2",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-fg">
                    {routine.title}
                  </span>
                  <span className="block truncate text-label text-fg-dim">
                    {summaryOf(routine)}
                  </span>
                </span>
                {routine.lastRun !== null && (
                  <OutcomeBadge outcome={routine.lastRun.outcome} />
                )}
              </a>
            </li>
          ))}
        </ul>
      </Section>
      {board.waiting.length > 0 && (
        <Section title="Waiting on someone">
          <ul className="flex flex-col gap-1 text-label">
            {board.waiting.map(({ routine, run }) => (
              <li key={run.id}>
                <a
                  href={runHref(routine, run.sessionId)}
                  className="flex min-w-0 flex-col rounded-md px-2 py-1 hover:bg-hover"
                >
                  <span className="text-fg">
                    {routine}:{" "}
                    {run.questions?.flatMap(({ prompts }) => prompts).join(" ")}
                  </span>
                  {run.askedFor !== undefined && run.askedFor.length > 0 && (
                    <span className="text-fg-dim">
                      For {run.askedFor.join(", ")}
                    </span>
                  )}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="Work">
        {board.work.length === 0 && <p className="text-fg-dim">No runs yet.</p>}
        <ul className="flex flex-col gap-2 text-label">
          {board.work.map((item) => (
            <li
              key={`${item.routine}-${item.key}`}
              className="flex flex-col gap-1"
            >
              <span className="text-fg">
                {item.title}
                {item.key === "" ? "" : `: ${item.key}`}
              </span>
              <span className="flex flex-wrap gap-1">
                {item.runs.map((run) => (
                  <a
                    key={run.id}
                    href={runHref(item.routine, run.sessionId)}
                    title={new Date(run.firedAt).toLocaleString()}
                  >
                    <OutcomeBadge outcome={run.outcome} />
                  </a>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Cost and success">
        <ul className="flex flex-col gap-1 text-label">
          {board.costs.map((cost) => (
            <li key={cost.name} className="flex flex-wrap gap-x-3">
              <span className="text-fg">{cost.title}</span>
              <span className="text-fg-dim">
                Spent today: {cost.spentToday.toFixed(2)}.{" "}
                {rateText(cost.successRate, cost.succeeded + cost.failed)}
              </span>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Memory">
        {Object.keys(board.memory).length === 0 && (
          <p className="text-fg-dim">
            Nothing yet. Runs add notes with the memory tool.
          </p>
        )}
        {Object.entries(board.memory).map(([file, text]) => (
          <Code key={file} label={file} wrap>
            {text}
          </Code>
        ))}
      </Section>
    </>
  );
}

// On-call lists as a line each, such as "triage: Ana, Bo".
export function onCallText(onCall: Group["onCall"]): string {
  return Object.entries(onCall ?? {})
    .map(([list, people]) => `${list}: ${people.join(", ")}`)
    .join("\n");
}

export function onCallOf(text: string): Group["onCall"] {
  const lists = text
    .split("\n")
    .map((line) => line.split(":"))
    .flatMap(([list = "", people = ""]) => {
      const named = listOf(people);

      return list.trim() === "" || named.length === 0
        ? []
        : [[list.trim(), named] as const];
    });

  return lists.length === 0 ? undefined : Object.fromEntries(lists);
}

function listOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((each) => each.trim())
    .filter((each) => each !== "");
}

function GroupForm({
  api,
  scope,
  name,
  group,
  onSaved,
}: {
  readonly api: TypedClient;
  readonly scope: Scope;
  readonly name: string | undefined;
  readonly group: Group | undefined;
  readonly onSaved: (name: string) => void;
}): ReactElement {
  const [newName, setNewName] = useState("");
  const [title, setTitle] = useState(group?.title ?? "");

  const [repositories, setRepositories] = useState(
    (group?.repositories ?? []).join("\n"),
  );

  const [profile, setProfile] = useState(group?.defaults?.profile ?? "");

  const [environment, setEnvironment] = useState(
    group?.defaults?.environment ?? "",
  );

  const [as, setAs] = useState(group?.defaults?.as ?? "");

  const [budget, setBudget] = useState(
    group?.budget === undefined ? "" : String(group.budget.dailySpend),
  );

  const [onCall, setOnCall] = useState(onCallText(group?.onCall));
  const [editors, setEditors] = useState((group?.editors ?? []).join(", "));
  const [failure, setFailure] = useState<string>();
  const profiles = useProfiles(api, scope);

  const environments =
    useLoaded(
      async () =>
        api.get<Named[]>(
          `/api/environments${scope === teams ? "?scope=team" : ""}`,
        ),
      `environments-${scope.prefix}`,
      { topics: ["environments"] },
    ).value ?? [];

  const save = (): void => {
    const target = name ?? newName.trim();
    const spend = Number(budget);
    const lists = onCallOf(onCall);
    const people = listOf(editors);

    const defaults = {
      ...(profile !== "" && { profile }),
      ...(environment !== "" && { environment }),
      ...(as.trim() !== "" && { as: as.trim() }),
    };

    const value: Group = {
      title: title.trim(),
      repositories: listOf(repositories),
      ...(Object.keys(defaults).length > 0 && { defaults }),
      ...(group?.limits !== undefined && { limits: group.limits }),
      ...(budget.trim() !== "" && { budget: { dailySpend: spend } }),
      ...(lists !== undefined && { onCall: lists }),
      ...(people.length > 0 && { editors: people }),
      ...(group?.coordinator !== undefined && {
        coordinator: group.coordinator,
      }),
    };

    api.put(`${scope.prefix}groups/${encodeURIComponent(target)}`, value).then(
      () => {
        onSaved(target);
      },
      (error: unknown) => {
        setFailure(failureOf(error));
      },
    );
  };

  return (
    <form
      aria-label="Group"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      className="mt-4 flex max-w-xl flex-col gap-3"
    >
      {name === undefined && (
        <Field label="Name" hint="Lower-case letters, digits and dashes">
          <TextInput
            aria-label="Name"
            placeholder="such as shop"
            value={newName}
            onChange={(event) => {
              setNewName(event.target.value);
            }}
          />
        </Field>
      )}
      <Field label="Title">
        <TextInput
          aria-label="Title"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
      </Field>
      <Field
        label="Repositories"
        hint="One a line: owner/name on github.com, host/owner/name, or an https address"
      >
        <TextArea
          aria-label="Repositories"
          rows={3}
          value={repositories}
          onChange={(event) => {
            setRepositories(event.target.value);
          }}
          className="h-auto font-mono text-label"
        />
      </Field>
      <Field label="Profile" hint="What its routines' runs start with">
        <Select
          aria-label="Profile"
          value={profile}
          onChange={(event) => {
            setProfile(event.target.value);
          }}
        >
          <option value="">The default</option>
          {profiles.map(({ id, name: label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Environment">
        <Select
          aria-label="Environment"
          value={environment}
          onChange={(event) => {
            setEnvironment(event.target.value);
          }}
        >
          <option value="">The default</option>
          {environments.map(({ id, name: label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="Acts as"
        hint="A technical user its runs' git acts as, such as a GitHub App"
      >
        <TextInput
          aria-label="Acts as"
          value={as}
          onChange={(event) => {
            setAs(event.target.value);
          }}
        />
      </Field>
      <Field
        label="Daily budget"
        hint="Reaching it pauses the group until the next day"
      >
        <TextInput
          aria-label="Daily budget"
          inputMode="decimal"
          value={budget}
          onChange={(event) => {
            setBudget(event.target.value);
          }}
        />
      </Field>
      <Field
        label="On call"
        hint="One list a line, such as triage: Ana, Bo. Each week the next person is on call."
      >
        <TextArea
          aria-label="On call"
          rows={2}
          value={onCall}
          onChange={(event) => {
            setOnCall(event.target.value);
          }}
          className="h-auto text-label"
        />
      </Field>
      {scope === teams && (
        <Field
          label="Editors"
          hint="Who may change it and its routines. Without any, anyone on the team may."
        >
          <TextInput
            aria-label="Editors"
            value={editors}
            onChange={(event) => {
              setEditors(event.target.value);
            }}
          />
        </Field>
      )}
      <ErrorText size="inherit" className="text-ui">
        {failure}
      </ErrorText>
      <div>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </div>
    </form>
  );
}
