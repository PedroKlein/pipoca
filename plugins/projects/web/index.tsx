import {
  type LinkProps,
  type NavItemsProps,
  type NoticeProps,
  type ToolCall,
  type ToolCallProps,
  type PageProps,
  useLoaded,
  useNow,
  defineWeb,
  href as pageHref,
  SessionView,
  useApi,
} from "@pipoca/plugins/web";
import {
  checkoutName,
  type Environment,
  type Profile,
  type Session,
} from "@pipoca/protocol";
import {
  Badge,
  type BadgeState,
  Button,
  buttonClass,
  Card,
  cardClass,
  cn,
  Code,
  ErrorText,
  Field,
  Icon,
  linkCardClass,
  Menu,
  Page,
  Picker,
  type PickerOption,
  popClass,
  Section,
  Segmented,
  Select,
  SessionRow,
  StatusDot,
  type DotTone,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useState,
} from "react";
import type { TypedClient } from "@pipoca/plugins";
import { projects } from "../plugin";
import {
  AssistantItems,
  Earlier,
  earlier,
  Home,
  Opening,
  projectList,
  TeamAssistant,
} from "./assistant";
import { Folder } from "./folder";
import {
  type ProjectNotices,
  type ProjectSummary,
  type ProjectView,
  type ThreadLinkView,
  type RunState,
  type ThreadView,
  type WorkState,
  workStates,
} from "../src/model";

// Thread states follow their Sessions.
const watched = { topics: ["sessions"], changes: ["projects"] };

export const web = defineWeb(projects, {
  settings: { group: "server", form: "auto" },
  pages: [
    // A plugin has one sidebar entry, so the Assistant is it and the
    // Project list sits under it (ADR 0052).
    {
      path: "",
      label: "Assistant",
      Page: ProjectsPage,
      nav: {
        Items,
        fills: (path) => path !== "" && path !== projectList,
        pinned: true,
      },
    },
    {
      path: "team-assistant",
      label: "Team assistant",
      Page: TeamAssistant,
      area: "hub",
    },
  ],
  sessionPath: (session) => `${session.plugin?.key ?? ""}/${session.id}`,
  slots: {
    home: Home,
    "notice:thread": ThreadNotice,
    "notice:thread_message": ThreadMessageNotice,
    "notice:coordinator_message": CoordinatorMessageNotice,
    "link:thread": ThreadLink,
    "session.toolCall:start_thread": StartThreadCard,
    "session.toolCall:message_thread": MessageThreadCard,
  },
});

// The person's own Projects, then the team's. A person outside team work
// gets none of the team's.
async function allProjects(api: TypedClient): Promise<ProjectSummary[]> {
  const [own, team] = await Promise.all([
    api.get<ProjectSummary[]>("projects"),
    api
      .raw("team/projects")
      .then(async (response) =>
        response.ok ? ((await response.json()) as ProjectSummary[]) : [],
      ),
  ]);

  return [...own, ...team];
}

function link(path: string): string {
  return pageHref(projects, path);
}

function useThread(id: string | undefined): ThreadLinkView | undefined {
  const api = useApi(projects);

  return useLoaded(
    async () =>
      id === undefined
        ? undefined
        : api.get<ThreadLinkView>(`threads/${encodeURIComponent(id)}`),
    id ?? "",
    watched,
  ).value;
}

function StateDot({
  thread,
}: {
  readonly thread: ThreadView | undefined;
}): ReactElement {
  return (
    <StatusDot
      tone={
        thread &&
        (thread.workState === "failed" ? "failed" : dots[groupOf(thread)])
      }
    />
  );
}

function ThreadLink({ target, label }: LinkProps): ReactElement {
  const thread = useThread(target);

  return (
    <a
      href={
        thread ? link(`${thread.projectId}/${thread.sessionId}`) : `#${target}`
      }
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line bg-elevated px-2 align-baseline text-label leading-relaxed font-medium text-fg no-underline hover:bg-hover"
    >
      <StateDot thread={thread} />
      <span className="truncate">{label}</span>
      {thread && (
        <span className="shrink-0 font-normal text-fg-dim">
          {workStateNames[thread.workState]}
        </span>
      )}
    </a>
  );
}

function argument(args: unknown, name: string): string | undefined {
  const value = (args as Record<string, unknown> | null)?.[name];

  return typeof value === "string" ? value : undefined;
}

function StartThreadCard({ call }: ToolCallProps): ReactElement {
  const threadId = /as (\S+)\.$/.exec(call.result?.text ?? "")?.[1];
  const thread = useThread(threadId);
  const title = thread?.title ?? argument(call.args, "title") ?? "Thread";

  const status = startStatus(call, thread);

  const open = thread && link(`${thread.projectId}/${thread.sessionId}`);

  return (
    <Card
      padding="none"
      aria-label={`Thread ${title}`}
      className="flex items-center gap-3 px-3 py-2"
    >
      <StateDot thread={thread} />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-medium text-fg-strong">
          {title}
        </span>
        <span
          className={cn(
            "truncate text-caption",
            call.status === "failed" ? "text-failed" : "text-fg-dim",
          )}
        >
          {status}
        </span>
      </div>
      {open !== undefined && (
        <>
          <a
            href={open}
            aria-label={`Open ${title} beside the coordinator`}
            className={iconLinkClass}
          >
            <Icon name="panel-right" className="size-4" />
          </a>
          <a
            href={`${open}/full`}
            aria-label={`Open ${title} fullscreen`}
            className={iconLinkClass}
          >
            <Icon name="maximize" className="size-4" />
          </a>
        </>
      )}
    </Card>
  );
}

const iconLinkClass = buttonClass({
  variant: "ghost",
  size: "sm",
  iconOnly: true,
});

function startStatus(call: ToolCall, thread: ThreadView | undefined): string {
  if (call.status === "running") {
    return "Starting…";
  }

  if (call.status === "failed") {
    return call.result?.text ?? "Didn't start";
  }

  if (thread === undefined) {
    return "Started";
  }

  return [
    workStateNames[thread.workState],
    thread.runState === "working" || thread.runState === "idle"
      ? undefined
      : runBadges[thread.runState]?.label,
    thread.branch ?? undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function MessageThreadCard({ call }: ToolCallProps): ReactElement {
  const threadId = argument(call.args, "thread");
  const thread = useThread(threadId);

  return (
    <MessageNotice
      from={
        <>
          To
          {thread ? (
            <ThreadLink target={thread.sessionId} label={thread.title} />
          ) : (
            (threadId ?? "a thread")
          )}
          {call.status === "failed" && (
            <span className="text-failed">· {call.result?.text}</span>
          )}
        </>
      }
      text={argument(call.args, "text") ?? ""}
    />
  );
}

// The server tags each notice it sends with the data its kind draws.
function noticeData<K extends keyof ProjectNotices>(
  { data }: NoticeProps,
  _kind: K,
): ProjectNotices[K] {
  return data as ProjectNotices[K];
}

function ThreadNotice(props: NoticeProps): ReactElement {
  const { threadId, title, event, workState, runState, reply } = noticeData(
    props,
    "thread",
  );

  const line = (
    <>
      <Icon name="chat" className="size-4 shrink-0" />
      <a
        href={`#${threadId}`}
        className="max-w-1/2 shrink-0 truncate font-medium text-fg"
      >
        {title}
      </a>
      <span className="truncate">
        {event} · {workStateNames[workState]}
        {runState === "working" || runState === "idle"
          ? ""
          : ` · ${runBadges[runState]?.label ?? runState}`}
      </span>
    </>
  );

  if (reply === undefined) {
    return (
      <p className="flex min-w-0 items-center gap-2 px-2 py-1 text-label text-fg-dim">
        {line}
      </p>
    );
  }

  return (
    <details className="group px-2 py-1 text-label text-fg-dim">
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2">
        {line}
        <Icon
          name="chevron-right"
          className="size-4 shrink-0 group-open:rotate-90"
        />
      </summary>
      <p className="mt-1 ml-6 break-words whitespace-pre-wrap">{reply}</p>
    </details>
  );
}

function ThreadMessageNotice(props: NoticeProps): ReactElement {
  const { threadId, title, text } = noticeData(props, "thread_message");

  return (
    <MessageNotice
      from={
        <a href={`#${threadId}`} className="font-medium text-fg">
          {title}
        </a>
      }
      text={text}
    />
  );
}

function CoordinatorMessageNotice(props: NoticeProps): ReactElement {
  const { text } = noticeData(props, "coordinator_message");

  return <MessageNotice from="Coordinator" text={text} />;
}

function MessageNotice({
  from,
  text,
}: {
  readonly from: ReactNode;
  readonly text: string;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-line px-3 py-2 text-label">
      <span className="flex items-center gap-2 text-caption text-fg-dim">
        <Icon name="chat" className="size-3.5 shrink-0" />
        {from}
      </span>
      <p className="break-words whitespace-pre-wrap text-fg">{text}</p>
    </div>
  );
}

function Items({ path }: NavItemsProps): ReactElement {
  const api = useApi(projects);

  const list = useLoaded(
    async () => allProjects(api),
    "projects",
    watched,
  ).value;

  return (
    <>
      <AssistantItems path={path} />
      <ul id="project-nav" className="flex flex-col gap-0.5">
        {list
          ?.filter((project) => project.coordinatorState !== "archived")
          .map((project) => (
            <li key={project.id}>
              <a
                href={link(project.id)}
                aria-current={
                  path?.split("/")[0] === project.id ? "page" : undefined
                }
                className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md py-1.5 pr-2 pl-10.5 text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
              >
                <span className="truncate text-label font-medium">
                  {project.name}
                </span>
                {project.needsYou > 0 ? (
                  <Badge state="waiting">{project.needsYou} needs you</Badge>
                ) : (
                  <span />
                )}
                <span className="col-span-2 truncate text-caption text-fg-dim">
                  {counted(project.repositories, "repository", "repositories")}{" "}
                  · coordinator {project.coordinatorState}
                </span>
              </a>
            </li>
          ))}
      </ul>
    </>
  );
}

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function ProjectsPage({ path }: PageProps): ReactElement {
  const api = useApi(projects);

  const [open = "", ...rest] = path.split("/");

  const go = (to: string): void => {
    location.hash = link(to);
  };

  const environments =
    useLoaded(
      async () => api.get<Environment[]>("/api/environments"),
      "environments",
      { topics: ["environments"] },
    ).value ?? [];

  if (open === earlier) {
    return <Earlier path={rest.join("/")} />;
  }

  if (open === "") {
    return <Opening />;
  }

  return open === projectList ? (
    <ProjectList environments={environments} onOpen={go} />
  ) : (
    <ProjectPage
      key={open}
      id={open}
      rest={rest.join("/")}
      environments={environments}
    />
  );
}

function ProjectList({
  environments,
  onOpen,
}: {
  readonly environments: readonly Environment[];
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const api = useApi(projects);

  const list = useLoaded(
    async () => allProjects(api),
    "projects",
    watched,
  ).value;

  const active = list?.filter(
    ({ coordinatorState }) => coordinatorState !== "archived",
  );

  const archived = list?.filter(
    ({ coordinatorState }) => coordinatorState === "archived",
  );

  return (
    <Page
      title="Projects"
      description="A Project is a coordinator session that starts threads across one or more repositories."
    >
      {active?.length === 0 && <p className="text-fg-dim">No Projects yet.</p>}
      <ProjectCards projects={active ?? []} onOpen={onOpen} />
      {archived !== undefined && archived.length > 0 && (
        <Section title="Archived">
          <ProjectCards projects={archived} onOpen={onOpen} />
        </Section>
      )}
      <Section title="New Project">
        <CreateForm environments={environments} onCreated={onOpen} />
      </Section>
    </Page>
  );
}

function ProjectCards({
  projects: shown,
  onOpen,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly onOpen: (id: string) => void;
}): ReactElement {
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {shown.map((project) => (
        <li key={project.id}>
          <button
            type="button"
            onClick={() => {
              onOpen(project.id);
            }}
            className={cn(
              linkCardClass,
              "flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left hover:bg-hover",
            )}
          >
            <span className="flex min-w-0 items-center gap-2 font-medium text-fg-strong">
              {project.name}
              {project.team && <Badge>Team</Badge>}
            </span>
            <span className="text-caption text-fg-dim">
              {project.threads} {project.threads === 1 ? "thread" : "threads"}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function modelNames(environments: readonly Environment[]): string[] {
  return [
    ...new Set(
      environments.flatMap((option) =>
        option.models.map(({ provider, id }) => `${provider}/${id}`),
      ),
    ),
  ];
}

function ProfileSelect({
  team,
  value,
  onChange,
}: {
  readonly team: boolean;
  readonly value: string;
  readonly onChange: (event: {
    readonly target: { readonly value: string };
  }) => void;
}): ReactElement {
  const api = useApi(projects);

  const profiles =
    useLoaded(
      async () =>
        api.get<Profile[]>(team ? "/api/profiles?scope=team" : "/api/profiles"),
      team ? "team-profiles" : "profiles",
      {
        topics: ["profiles"],
      },
    ).value ?? [];

  return (
    <Select value={value} onChange={onChange}>
      {!team && <option value="">The default Profile</option>}
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
        </option>
      ))}
    </Select>
  );
}

function recentRepositories(sessions: readonly Session[]): string[] {
  const repositories = [...sessions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .flatMap(({ workspace }) => {
      switch (workspace.kind) {
        case "folder":
        case "worktree":
          return [workspace.path];
        case "clone":
          return [workspace.repository];
        case "repositories":
          return workspace.repositories.map(({ repository }) => repository);
      }
    });

  return [...new Set(repositories)].slice(0, 8);
}

function repositoryOption(repository: string): PickerOption {
  return {
    value: repository,
    label: checkoutName(repository) ?? repository,
    detail: repository,
  };
}

// A name, the repositories and a goal; the rest takes its defaults and is
// changed behind the Project's gear (ADR 0040).
function CreateForm({
  environments,
  onCreated,
}: {
  readonly environments: readonly Environment[];
  readonly onCreated: (id: string) => void;
}): ReactElement {
  const api = useApi(projects);

  const sessions =
    useLoaded(async () => api.get<Session[]>("/api/sessions"), "sessions", {
      topics: ["sessions"],
    }).value ?? [];

  const teamEnvironments =
    useLoaded(
      async () => api.get<Environment[]>("/api/environments?scope=team"),
      "team-environments",
      { topics: ["environments"] },
    ).value ?? [];

  const [teamProfile] =
    useLoaded(
      async () => api.get<Profile[]>("/api/profiles?scope=team"),
      "team-profiles",
      { topics: ["profiles"] },
    ).value ?? [];

  const [repositories, setRepositories] = useState<readonly string[]>([]);
  const [environment, setEnvironment] = useState("");
  const [forTeam, setForTeam] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const offered = forTeam ? teamEnvironments : environments;
  const chosen = offered.find(({ id }) => id === environment);

  const options = [
    ...new Set([...recentRepositories(sessions), ...repositories]),
  ].map(repositoryOption);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (creating) {
      return;
    }

    const data = new FormData(event.currentTarget);

    const field = (name: string): string => {
      const value = data.get(name);

      return typeof value === "string" ? value : "";
    };

    setCreating(true);
    setError(undefined);

    api
      .post<ProjectView>(forTeam ? "team/projects" : "projects", {
        name: field("name"),
        goal: field("goal"),
        repositories,
        environment: chosen?.id ?? offered[0]?.id ?? "",
        ...(forTeam && { profile: teamProfile?.id ?? "" }),
      })
      .then(
        (project) => {
          onCreated(project.id);
        },
        (failure: unknown) => {
          setCreating(false);

          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        },
      );
  };

  return (
    <form
      onSubmit={submit}
      className={cn(cardClass, "project-create grid max-w-xl gap-3 p-5")}
    >
      {teamEnvironments.length > 0 && teamProfile !== undefined && (
        <Segmented
          label="Whose Project"
          value={forTeam ? "team" : "mine"}
          onChange={(value) => {
            setForTeam(value === "team");
            setEnvironment("");
          }}
          options={[
            { value: "mine", label: "Mine" },
            { value: "team", label: "The team's" },
          ]}
        />
      )}
      <Field label="Name">
        <TextInput name="name" required />
      </Field>
      <Field label="Goal">
        <TextArea
          name="goal"
          rows={2}
          placeholder="What is this Project for? Every thread sees it."
        />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5">
        <Picker
          label="Repositories"
          options={options}
          selected={repositories}
          multiple
          placeholder="Search, or paste a repository URL"
          create={(query) => ({
            value: query,
            label: `Use ${query}`,
            detail: "clone",
          })}
          onChange={setRepositories}
        >
          {repositories.length === 0 ? (
            <span className="text-fg-dim">Pick repositories</span>
          ) : (
            repositories
              .map((repository) => checkoutName(repository) ?? repository)
              .join(", ")
          )}
        </Picker>
        {offered.length > 1 && (
          <Picker
            label="Environment"
            options={offered.map(({ id, name }) => ({
              value: id,
              label: name,
            }))}
            selected={[chosen?.id ?? offered[0]?.id ?? ""]}
            onChange={([id]) => {
              setEnvironment(id ?? "");
            }}
          >
            <span className="text-fg-dim">on </span>
            {(chosen ?? offered[0])?.name}
          </Picker>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={creating || repositories.length === 0}
          className="ml-auto"
        >
          Create Project
        </Button>
      </div>
      <ErrorText size="caption">{error}</ErrorText>
    </form>
  );
}

type Panel =
  | { readonly kind: "none" }
  | { readonly kind: "settings" }
  | { readonly kind: "folder" }
  | { readonly kind: "thread"; readonly id: string; readonly full: boolean };

// "" is the coordinator alone, "settings" its settings beside it, and a
// thread's id opens it beside the coordinator, or fullscreen with "/full".
function panelOf(rest: string, project: ProjectView): Panel {
  const [first = "", second] = rest.split("/");

  if (first === "settings" || first === "folder") {
    return { kind: first };
  }

  if (first === "" || first === project.coordinatorId) {
    return { kind: "none" };
  }

  return { kind: "thread", id: first, full: second === "full" };
}

const railKey = "pipoca.projects.rail";

function useRail(): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return (
        matchMedia("(width >= 48rem)").matches &&
        localStorage.getItem(railKey) !== "closed"
      );
    } catch {
      return true;
    }
  });

  return [
    open,
    (next) => {
      setOpen(next);

      try {
        if (matchMedia("(width >= 48rem)").matches) {
          localStorage.setItem(railKey, next ? "open" : "closed");
        }
      } catch {
        // The choice only lasts this visit.
      }
    },
  ];
}

function ProjectPage({
  id,
  rest,
  environments,
}: {
  readonly id: string;
  readonly rest: string;
  readonly environments: readonly Environment[];
}): ReactElement {
  const api = useApi(projects);

  const path = `projects/${encodeURIComponent(id)}`;
  const [railOpen, setRailOpen] = useRail();

  const { value: project, reload } = useLoaded(
    async () => {
      const response = await api.raw(path);

      if (response.status === 404) {
        return null;
      }

      return api.get<ProjectView>(path);
    },
    path,
    watched,
  );

  if (project === undefined) {
    return <div className="flex-1" />;
  }

  if (project === null) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 p-8">
        <p className="text-fg-dim">Project not found.</p>
        <a href={link("")} className="text-accent hover:underline">
          All Projects
        </a>
      </div>
    );
  }

  const panel = panelOf(rest, project);

  const to = (where: string): string =>
    link(where === "" ? id : `${id}/${where}`);

  const go = (where: string): void => {
    location.hash = to(where);
  };

  const thread =
    panel.kind === "thread"
      ? project.threads.find(({ sessionId }) => sessionId === panel.id)
      : undefined;

  const beside = besideOf(panel, railOpen);

  const railToggle = (
    <Button
      variant="ghost"
      iconOnly
      aria-label={beside === undefined ? "Show threads" : "Hide threads"}
      aria-pressed={beside !== undefined}
      onClick={() => {
        setRailOpen(beside === undefined);

        if (
          beside === "settings" ||
          beside === "folder" ||
          beside === "thread"
        ) {
          go("");
        }
      }}
      className="relative"
    >
      <Icon name="panel-right" />
      {needsYou(project.threads) > 0 && (
        <StatusDot tone="waiting" className="absolute top-1 right-1" />
      )}
    </Button>
  );

  const column =
    "flex min-h-0 shrink-0 flex-col border-l border-line max-md:fixed max-md:inset-0 max-md:z-20 max-md:w-full";

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {panel.kind === "thread" && panel.full ? (
          <SessionView
            sessionId={panel.id}
            layout="full"
            {...(thread && { title: thread.title })}
            crumb={
              <>
                <a
                  href={to("")}
                  className="shrink-0 font-normal text-fg-dim hover:text-fg hover:underline"
                >
                  {project.name}
                </a>
                <Icon
                  name="chevron-right"
                  className="size-3.5 shrink-0 text-fg-dim"
                />
              </>
            }
            actions={
              <>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Show beside the coordinator"
                  onClick={() => {
                    go(panel.id);
                  }}
                  className="max-md:hidden"
                >
                  <Icon name="minimize" />
                </Button>
                {railToggle}
              </>
            }
          />
        ) : (
          <SessionView
            sessionId={project.coordinatorId}
            layout="full"
            title={project.name}
            actions={
              <>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Project folder"
                  aria-pressed={panel.kind === "folder"}
                  onClick={() => {
                    go(panel.kind === "folder" ? "" : "folder");
                  }}
                >
                  <Icon name="paperclip" />
                </Button>
                <Button
                  variant="ghost"
                  iconOnly
                  aria-label="Project settings"
                  aria-pressed={panel.kind === "settings"}
                  onClick={() => {
                    go(panel.kind === "settings" ? "" : "settings");
                  }}
                >
                  <Icon name="settings" />
                </Button>
                {railToggle}
              </>
            }
          />
        )}
      </div>

      {beside === "thread" && panel.kind === "thread" && (
        <aside
          aria-label={thread?.title ?? "Thread"}
          className={cn(column, "w-[min(36rem,50%)] bg-bg")}
        >
          <SessionView
            sessionId={panel.id}
            layout="side"
            {...(thread && { title: thread.title })}
            crumb={
              <Button
                variant="ghost"
                iconOnly
                aria-label="Back to threads"
                onClick={() => {
                  setRailOpen(true);
                  go("");
                }}
                className="-ml-2"
              >
                <Icon name="chevron-right" className="rotate-180" />
              </Button>
            }
            actions={
              <Button
                variant="ghost"
                iconOnly
                aria-label="Open fullscreen"
                onClick={() => {
                  go(`${panel.id}/full`);
                }}
              >
                <Icon name="maximize" />
              </Button>
            }
          />
        </aside>
      )}

      {beside === "settings" && (
        <aside
          aria-label="Project settings"
          className={cn(column, "w-[min(30rem,45%)] bg-bg")}
        >
          <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
            <h2 className="flex-1 text-title font-semibold text-fg-strong">
              Settings
            </h2>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Close settings"
              onClick={() => {
                go("");
              }}
            >
              <Icon name="x" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <ul className="flex flex-col gap-1 font-mono text-mono-sm text-fg-dim">
              {project.repositories.map((repository) => (
                <li key={repository} className="truncate">
                  {repository}
                </li>
              ))}
            </ul>
            <Settings
              path={path}
              project={project}
              onSaved={reload}
              models={modelNames(
                environments.filter(
                  (environment) =>
                    project.environmentId === null ||
                    environment.id === project.environmentId,
                ),
              )}
            />
            <section aria-label="Memory" className="flex flex-col gap-2">
              <h3 className="text-label font-medium text-fg-dim">Memory</h3>
              <Memory path={path} project={project} />
            </section>
            <StartFresh
              path={path}
              project={project}
              href={to}
              onDone={() => {
                reload();
                go("");
              }}
            />
            <ArchiveProject project={project} onDone={reload} />
          </div>
        </aside>
      )}

      {beside === "folder" && (
        <aside
          aria-label="Project folder"
          className={cn(column, "w-[min(30rem,45%)] bg-bg")}
        >
          <header className="flex min-h-14 items-center gap-2 border-b border-line px-4">
            <h2 className="flex-1 text-title font-semibold text-fg-strong">
              Folder
            </h2>
            <Button
              variant="ghost"
              iconOnly
              aria-label="Close folder"
              onClick={() => {
                go("");
              }}
            >
              <Icon name="x" />
            </Button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <Folder path={path} />
          </div>
        </aside>
      )}

      {beside === "list" && (
        <Rail
          project={project}
          environments={environments}
          current={panel.kind === "thread" ? panel.id : undefined}
          href={to}
          className={cn(column, "w-64 bg-panel")}
          onClose={() => {
            setRailOpen(false);
          }}
        />
      )}
    </div>
  );
}

// The column beside the chat shows the open thread or the settings, or else
// the list of threads while it is open.
function besideOf(
  panel: Panel,
  railOpen: boolean,
): "thread" | "settings" | "folder" | "list" | undefined {
  if (
    panel.kind === "settings" ||
    panel.kind === "folder" ||
    (panel.kind === "thread" && !panel.full)
  ) {
    return panel.kind;
  }

  return railOpen ? "list" : undefined;
}

function needsYou(threads: readonly ThreadView[]): number {
  return threads.filter((thread) => groupOf(thread) === "Needs you").length;
}

type Group = "Needs you" | "Working" | "Review" | "Idle" | "Finished";

const groups: readonly Exclude<Group, "Finished">[] = [
  "Needs you",
  "Working",
  "Review",
  "Idle",
];

function groupOf({ workState, runState }: ThreadView): Group {
  if (workState === "blocked" || runState === "waiting") {
    return "Needs you";
  }

  if (workState === "done" || workState === "failed") {
    return "Finished";
  }

  if (runState === "working") {
    return "Working";
  }

  return workState === "review_ready" ? "Review" : "Idle";
}

const dots: Readonly<Record<Group, DotTone>> = {
  "Needs you": "waiting",
  Working: "working",
  Review: "accent",
  Idle: "offline",
  Finished: "done",
};

function Rail({
  project,
  environments,
  current,
  href,
  className,
  onClose,
}: {
  readonly project: ProjectView;
  readonly environments: readonly Environment[];
  readonly current: string | undefined;
  readonly href: (where: string) => string;
  readonly className: string;
  readonly onClose: () => void;
}): ReactElement {
  const now = useNow();

  const finished = project.threads.filter(
    (thread) => groupOf(thread) === "Finished",
  );

  const rows = (threads: readonly ThreadView[]): ReactElement => (
    <ul className="flex flex-col gap-0.5">
      {threads.map((thread) => (
        <ThreadRow
          key={thread.sessionId}
          thread={thread}
          current={thread.sessionId === current}
          href={href(thread.sessionId)}
          meta={[
            environments.find(({ id }) => id === thread.environmentId)?.name ??
              thread.environmentId,
            since(thread.lastActivity, now),
          ].join(" · ")}
        />
      ))}
    </ul>
  );

  return (
    <nav aria-label="Threads" className={className}>
      <header className="flex min-h-14 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 className="flex-1 text-label font-semibold text-fg-strong">
          Threads
        </h2>
        <Button
          variant="ghost"
          iconOnly
          aria-label="Hide threads"
          onClick={onClose}
          className="md:hidden"
        >
          <Icon name="x" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-2">
        {project.threads.length === 0 && (
          <p className="px-2 py-1 text-caption text-fg-dim">
            No threads yet. Ask the coordinator to start some.
          </p>
        )}
        {groups.map((group) => {
          const shown = project.threads.filter(
            (thread) => groupOf(thread) === group,
          );

          return shown.length === 0 ? null : (
            <section key={group} aria-label={group}>
              <h3 className="flex items-center gap-2 px-2 pb-1 text-caption font-medium text-fg-dim">
                {group} · {shown.length}
              </h3>
              {rows(shown)}
            </section>
          );
        })}
        {finished.length > 0 && (
          <details aria-label="Finished">
            <summary className="cursor-pointer px-2 pb-1 text-caption font-medium text-fg-dim">
              Finished ({finished.length})
            </summary>
            {rows(finished)}
          </details>
        )}
      </div>
    </nav>
  );
}

function since(time: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(time)) / 60_000);

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }

  const hours = Math.floor(minutes / 60);

  return hours < 24
    ? `${String(hours)}h ago`
    : `${String(Math.floor(hours / 24))}d ago`;
}

function ThreadRow({
  thread,
  current,
  href,
  meta,
}: {
  readonly thread: ThreadView;
  readonly current: boolean;
  readonly href: string;
  readonly meta: string;
}): ReactElement {
  const badge = runBadges[thread.runState];

  return (
    <SessionRow
      label={thread.title}
      href={href}
      current={current}
      title={thread.title}
      leading={<StateDot thread={thread} />}
      meta={meta}
      {...(badge && { badge })}
      actions={<ThreadMenu thread={thread} />}
    />
  );
}

function ThreadMenu({ thread }: { readonly thread: ThreadView }): ReactElement {
  const api = useApi(projects);

  const [error, setError] = useState("");

  const run = (sent: Promise<unknown>): void => {
    setError("");

    sent.catch((failure: unknown) => {
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };

  return (
    <div className="relative">
      <Menu
        label={`Actions for ${thread.title}`}
        triggerClassName="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
        items={[
          ...workStates.map((state) => ({
            label: workStateNames[state],
            checked: thread.workState === state,
            run: () => {
              run(
                api.post(
                  `threads/${encodeURIComponent(thread.sessionId)}/state`,
                  { state },
                ),
              );
            },
          })),
          {
            label: "Archive",
            icon: "archive" as const,
            divided: true,
            run: () => {
              run(
                api.patch(
                  `/api/sessions/${encodeURIComponent(thread.sessionId)}`,
                  { archived: true },
                ),
              );
            },
          },
        ]}
      />
      <ErrorText
        size="caption"
        className={cn("absolute top-full right-0 z-30 w-48 p-2", popClass)}
      >
        {error}
      </ErrorText>
    </div>
  );
}

const workStateNames: Readonly<Record<WorkState, string>> = {
  in_progress: "In progress",
  blocked: "Blocked",
  review_ready: "Ready for review",
  done: "Done",
  failed: "Failed",
};

const runBadges: Readonly<
  Record<RunState, { state: BadgeState; label: string } | undefined>
> = {
  working: { state: "working", label: "Working" },
  waiting: { state: "waiting", label: "Needs you" },
  idle: undefined,
  offline: { state: "offline", label: "Offline" },
  interrupted: { state: "offline", label: "Interrupted" },
  archived: { state: "offline", label: "Archived" },
};

function Settings({
  path,
  project,
  onSaved,
  models,
}: {
  readonly path: string;
  readonly project: ProjectView;
  readonly onSaved: () => void;
  readonly models: readonly string[];
}): ReactElement {
  const api = useApi(projects);

  const saved = {
    name: project.name,
    goal: project.goal,
    threadModel: project.threadModel ?? "",
    profile: project.profileId ?? "",
    instructions: project.instructions,
  };

  const [draft, setDraft] = useState(saved);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const changed = (Object.keys(saved) as (keyof typeof saved)[]).some(
    (key) => draft[key] !== saved[key],
  );

  const edit =
    (key: keyof typeof saved) =>
    (event: { readonly target: { readonly value: string } }): void => {
      setDraft({ ...draft, [key]: event.target.value });
    };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setError("");
        setSaving(true);

        api
          .post(`${path}/settings`, draft)
          .then(onSaved, (failure: unknown) => {
            setError(
              failure instanceof Error ? failure.message : String(failure),
            );
          })
          .finally(() => {
            setSaving(false);
          });
      }}
      className="grid max-w-xl gap-3"
    >
      <Field label="Name">
        <TextInput required value={draft.name} onChange={edit("name")} />
      </Field>
      <Field label="Goal">
        <TextArea rows={2} value={draft.goal} onChange={edit("goal")} />
      </Field>
      <Field label="Thread model">
        <TextInput
          list="project-settings-models"
          placeholder="The coordinator's model"
          value={draft.threadModel}
          onChange={edit("threadModel")}
          className="font-mono text-mono-sm"
        />
      </Field>
      <Field label="Profile">
        <ProfileSelect
          team={project.team}
          value={draft.profile}
          onChange={edit("profile")}
        />
      </Field>
      <datalist id="project-settings-models">
        {models.map((ref) => (
          <option key={ref} value={ref} />
        ))}
      </datalist>
      <Field label="Instructions">
        <TextArea
          rows={4}
          value={draft.instructions}
          onChange={edit("instructions")}
        />
      </Field>
      <p className="text-caption text-fg-dim">
        New threads use these. The coordinator&apos;s model is in its own model
        menu.
      </p>
      <Button
        type="submit"
        disabled={!changed || saving}
        className="justify-self-start"
      >
        Save settings
      </Button>
      <ErrorText size="caption">{error}</ErrorText>
    </form>
  );
}

function StartFresh({
  path,
  project,
  href,
  onDone,
}: {
  readonly path: string;
  readonly project: ProjectView;
  readonly href: (where: string) => string;
  readonly onDone: () => void;
}): ReactElement {
  const api = useApi(projects);

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <section
      aria-label="Coordinator"
      className="flex flex-col items-start gap-2"
    >
      <p className="text-caption text-fg-dim">
        A fresh coordinator starts with an empty context and a handoff: the
        latest messages, the threads and memory. This happens by itself when the
        coordinator&apos;s context fills up.
      </p>
      <Button
        disabled={busy || project.coordinatorState === "archived"}
        onClick={() => {
          setError("");
          setBusy(true);

          api
            .post(`${path}/fresh`)
            .then(onDone, (failure: unknown) => {
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            })
            .finally(() => {
              setBusy(false);
            });
        }}
      >
        <Icon name="plus" />
        Start fresh
      </Button>
      {project.formerCoordinators.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-caption">
          {project.formerCoordinators.toReversed().map((sessionId, index) => (
            <li key={sessionId}>
              <a
                href={href(`${sessionId}/full`)}
                className="text-fg-dim hover:text-fg hover:underline"
              >
                Earlier conversation {project.formerCoordinators.length - index}
              </a>
            </li>
          ))}
        </ul>
      )}
      <ErrorText size="caption">{error}</ErrorText>
    </section>
  );
}

function ArchiveProject({
  project,
  onDone,
}: {
  readonly project: ProjectView;
  readonly onDone: () => void;
}): ReactElement {
  const api = useApi(projects);

  const [ask, asking] = useConfirm();
  const archived = project.coordinatorState === "archived";
  const [error, setError] = useState("");

  return (
    <section aria-label="Archive" className="flex flex-col items-start gap-2">
      {asking}
      <p className="text-caption text-fg-dim">
        {archived
          ? "Unarchiving brings back the coordinator and the threads archived with it."
          : "Archiving stops the coordinator and every thread, and removes their clean checkouts. Memory and settings stay."}
      </p>
      <Button
        onClick={() => {
          void (
            archived
              ? Promise.resolve(true)
              : ask({
                  title: `Archive ${project.name} and all its threads?`,
                  confirm: "Archive",
                  danger: true,
                })
          ).then((yes) => {
            if (!yes) {
              return;
            }

            setError("");

            api
              .patch(
                `/api/sessions/${encodeURIComponent(project.coordinatorId)}`,
                { archived: !archived },
              )
              .then(onDone, (failure: unknown) => {
                setError(
                  failure instanceof Error ? failure.message : String(failure),
                );
              });
          });
        }}
      >
        <Icon name="archive" />
        {archived ? "Unarchive Project" : "Archive Project"}
      </Button>
      <ErrorText size="caption">{error}</ErrorText>
    </section>
  );
}

function Memory({
  path,
  project,
}: {
  readonly path: string;
  readonly project: ProjectView;
}): ReactElement {
  const api = useApi(projects);

  const [shown, setShown] = useState<string>();
  const open = project.memory.find(({ name }) => name === shown);
  const version = open ? `${open.name} ${open.updatedAt}` : "";

  const content = useLoaded(async () => {
    if (shown === undefined) {
      return "";
    }

    const reply = await api.raw(`${path}/memory/${encodeURIComponent(shown)}`);

    return reply.ok
      ? ((await reply.json()) as { content: string }).content
      : "";
  }, version).value;

  if (project.memory.length === 0) {
    return <p className="text-fg-dim">Memory is empty.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
      <ul className="flex flex-col gap-0.5">
        {project.memory.map((file) => (
          <li key={file.name}>
            <button
              type="button"
              aria-current={file.name === shown ? "true" : undefined}
              onClick={() => {
                setShown(file.name);
              }}
              className="flex w-full cursor-pointer flex-col rounded-md px-3 py-1.5 text-left hover:bg-hover aria-[current=true]:bg-hover"
            >
              <span className="font-mono text-mono-sm text-fg">
                {file.name}
              </span>
              <span className="text-caption text-fg-dim">
                {file.size} bytes · {file.actor}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {shown !== undefined && (
        <Code wrap className="max-h-[60vh] overflow-auto">
          {content}
        </Code>
      )}
    </div>
  );
}
