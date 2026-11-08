import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  buttonClass,
  Cell,
  cn,
  ErrorText,
  Icon,
  linkCardClass,
  Menu,
  type MenuItem,
  Page,
  plural,
  Section,
  Table,
} from "@pipoca/ui";
import type { DeclaredEvent } from "@pipoca/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import { routines } from "../plugin";
import type { RoutineDetail, RoutineView } from "../src/model";
import {
  changes,
  failureOf,
  groupPage,
  OutcomeBadge,
  pageAt,
  type Scope,
  teams,
  yours,
} from "./common";
import { Groups, ImportGroup } from "./groups";
import { starters } from "./starters";
import { placeWords, shortTime, whenWords } from "./words";

const lede =
  "Work that starts by itself: on a schedule, when something happens, or after another routine.";

// The routine names to titles, and the events triggers can name.
function useNames(scope: Scope): {
  readonly list: readonly RoutineView[] | undefined;
  readonly titleOf: (name: string) => string;
  readonly events: readonly DeclaredEvent[];
} {
  const api = useApi(routines);

  const list = useLoaded(
    async () => api.get<RoutineView[]>(`${scope.prefix}routines`),
    `${scope.prefix}routines`,
    { changes },
  ).value;

  const events =
    useLoaded(async () => api.get<DeclaredEvent[]>("events"), "events").value ??
    [];

  const titleOf = (name: string): string =>
    (Array.isArray(list) ? list : []).find((each) => each.name === name)
      ?.title ?? name;

  return { list: Array.isArray(list) ? list : undefined, titleOf, events };
}

export function RoutineList(): ReactElement {
  const api = useApi(routines);
  const [importing, setImporting] = useState<Scope>();

  const team =
    useLoaded(
      async () => api.get<unknown[]>("/api/environments?scope=team"),
      "team-environments",
      { topics: ["environments"] },
    ).value ?? [];

  const go = (path: string) => () => {
    location.hash = pageAt(path);
  };

  const hasTeam = team.length > 0;

  const more: MenuItem[] = [
    { label: "New group", run: go(`${groupPage}new`) },
    {
      label: "Import a group",
      run: () => {
        setImporting(yours);
      },
    },
    ...(hasTeam
      ? [
          {
            label: "New team routine",
            divided: true,
            run: go(`${teams.prefix}new`),
          },
          {
            label: "New team group",
            run: go(`${teams.prefix}${groupPage}new`),
          },
          {
            label: "Import a team group",
            run: () => {
              setImporting(teams);
            },
          },
        ]
      : []),
  ];

  return (
    <Page
      title="Routines"
      description={lede}
      wide
      actions={
        <>
          <Menu
            label="More ways to add"
            items={more}
            trigger={
              <>
                More <Icon name="chevron-down" className="size-3.5" />
              </>
            }
          />
          <a
            href={pageAt("new")}
            className={buttonClass({ variant: "primary" })}
          >
            <Icon name="plus" className="size-3.5" />
            New routine
          </a>
        </>
      }
    >
      {importing !== undefined && (
        <ImportGroup
          scope={importing}
          title={importing === teams ? "Import a team group" : "Import a group"}
        />
      )}
      <Groups scope={yours} title="Your groups" />
      <RoutineTable scope={yours} title="Yours" />
      {hasTeam && <Groups scope={teams} title="The team's groups" />}
      {hasTeam && <RoutineTable scope={teams} title="The team's" />}
      <Starters />
    </Page>
  );
}

// The team's routines in the team's own area, beside its assistant.
export function TeamRoutinesScreen(): ReactElement {
  const [importing, setImporting] = useState(false);

  return (
    <Page
      title="Team routines"
      description={`${lede} Anyone on the team makes and changes these.`}
      actions={
        <>
          <Menu
            label="More ways to add"
            items={[
              {
                label: "New team group",
                run: () => {
                  location.hash = pageAt(`${teams.prefix}${groupPage}new`);
                },
              },
              {
                label: "Import a team group",
                run: () => {
                  setImporting(true);
                },
              },
            ]}
            trigger={
              <>
                More <Icon name="chevron-down" className="size-3.5" />
              </>
            }
          />
          <a
            href={pageAt(`${teams.prefix}new`)}
            className={buttonClass({ variant: "primary" })}
          >
            <Icon name="plus" className="size-3.5" />
            New team routine
          </a>
        </>
      }
    >
      {importing && <ImportGroup scope={teams} title="Import a team group" />}
      <Groups scope={teams} title="Groups" />
      <RoutineTable scope={teams} title="Routines" />
    </Page>
  );
}

function RoutineTable({
  scope,
  title,
}: {
  readonly scope: Scope;
  readonly title: string;
}): ReactElement {
  const { list, titleOf, events } = useNames(scope);

  return (
    <Section title={title}>
      {list?.length === 0 && <p className="text-fg-dim">No routines yet.</p>}
      {list !== undefined && list.length > 0 && (
        <Table
          label={title}
          columns={[
            "Routine",
            "When",
            "Next",
            "Last run",
            <span key="actions" className="sr-only">
              Actions
            </span>,
          ]}
        >
          {list.map((routine) => (
            <RoutineRow
              key={routine.name}
              scope={scope}
              view={routine}
              titleOf={titleOf}
              events={events}
            />
          ))}
        </Table>
      )}
    </Section>
  );
}

const hint = "text-label text-fg-dim";

function RoutineRow({
  scope,
  view,
  titleOf,
  events,
}: {
  readonly scope: Scope;
  readonly view: RoutineView;
  readonly titleOf: (name: string) => string;
  readonly events: readonly DeclaredEvent[];
}): ReactElement {
  const api = useApi(routines);
  const [failure, setFailure] = useState<string>();
  const path = `${scope.prefix}routines/${encodeURIComponent(view.name)}`;
  const page = pageAt(`${scope.prefix}${view.name}`);

  const detail = useLoaded(
    async () => api.get<RoutineDetail>(path),
    `row-${scope.prefix}${view.name}`,
    { changes },
  ).value;

  const routine = detail?.routine;

  const about = [
    routine === undefined ? undefined : placeWords(routine),
    view.group === undefined ? undefined : `in ${view.group}`,
    detail !== undefined && detail.feeds.length > 0
      ? `feeds ${plural(detail.feeds.length, "routine")}`
      : undefined,
    detail !== undefined && detail.fedBy.length > 0
      ? `after ${detail.fedBy.map(titleOf).join(", ")}`
      : undefined,
    routine?.do.kind === "session" && routine.do.as !== undefined
      ? `acts as ${routine.do.as}`
      : undefined,
  ].filter((part) => part !== undefined);

  const act = (action: string, body?: object): void => {
    setFailure(undefined);

    api.post(`${path}/${action}`, body).catch((error: unknown) => {
      setFailure(failureOf(error));
    });
  };

  const kinds = new Set(routine?.when.map(({ kind }) => kind));

  const running =
    detail?.runs.filter(({ outcome }) => outcome === "running").length ?? 0;

  const next = (): ReactNode => {
    if (view.nextAt !== null && view.paused === null) {
      return shortTime(view.nextAt);
    }

    const on = (
      [
        ["event", "on events"],
        ["webhook", "on webhook"],
        ["watch", "on changes"],
      ] as const
    ).find(([kind]) => kinds.has(kind));

    return <span className={hint}>{on?.[1] ?? "nothing scheduled"}</span>;
  };

  const last = (): ReactNode => {
    if (view.paused !== null) {
      return (
        <>
          <Badge state="waiting">Paused</Badge>
          <span className={cn("min-w-0 truncate", hint)}>{view.paused}</span>
        </>
      );
    }

    if (running > 0) {
      return <Badge state="working">{`${String(running)} running`}</Badge>;
    }

    if (view.lastRun === null) {
      return <span className={hint}>No runs yet</span>;
    }

    return (
      <>
        <OutcomeBadge outcome={view.lastRun.outcome} />
        {view.lastRun.reason !== null && (
          <span
            title={view.lastRun.reason}
            className={cn("min-w-0 truncate", hint)}
          >
            {view.lastRun.reason}
          </span>
        )}
      </>
    );
  };

  const needsInputs = Object.keys(routine?.inputs ?? {}).length > 0;

  return (
    <tr>
      <Cell>
        <a
          href={page}
          className="block max-w-44 truncate font-medium text-fg-strong hover:underline"
        >
          {view.title}
        </a>
        {about.length > 0 && (
          <span className={cn("block max-w-44 truncate", hint)}>
            {about.join(" · ")}
          </span>
        )}
      </Cell>
      <Cell>
        {view.error === undefined ? (
          routine !== undefined && whenWords(routine, titleOf, events)
        ) : (
          <ErrorText size="inherit" inline>
            Doesn&apos;t load: {view.error}
          </ErrorText>
        )}
      </Cell>
      <Cell className="whitespace-nowrap">{next()}</Cell>
      <Cell>
        <span className="flex max-w-36 min-w-0 items-center gap-2">
          {last()}
        </span>
        <ErrorText>{failure}</ErrorText>
      </Cell>
      <Cell className="text-right whitespace-nowrap">
        {view.paused !== null && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Resume ${view.title}`}
            onClick={() => {
              act("resume");
            }}
          >
            Resume
          </Button>
        )}
        {view.paused === null && needsInputs && (
          <a
            href={page}
            className={buttonClass({ variant: "ghost", size: "sm" })}
          >
            Run now
          </a>
        )}
        {view.paused === null && !needsInputs && (
          <Button
            variant="ghost"
            size="sm"
            disabled={view.error !== undefined}
            aria-label={`Run ${view.title} now`}
            onClick={() => {
              act("run", { dryRun: false });
            }}
          >
            Run now
          </Button>
        )}
      </Cell>
    </tr>
  );
}

// Starters that each open the form filled in, then a blank one.
function Starters(): ReactElement {
  const tile = cn(linkCardClass, "flex flex-col gap-1 p-3.5");

  return (
    <Section title="Start from" description="each opens the form filled in">
      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
        {starters.map((starter) => (
          <li key={starter.name} className="flex">
            <a
              href={pageAt(`new/${starter.name}`)}
              className={cn(tile, "flex-1")}
            >
              <span className="text-ui font-medium text-fg-strong">
                {starter.label}
              </span>
              <span className={hint}>{starter.description}</span>
            </a>
          </li>
        ))}
        <li className="flex">
          <a
            href={pageAt("new")}
            className={cn(tile, "flex-1 border-dashed shadow-none")}
          >
            <span className="text-ui font-medium text-fg-strong">Blank</span>
            <span className={hint}>Or ask the assistant to make one.</span>
          </a>
        </li>
      </ul>
    </Section>
  );
}
