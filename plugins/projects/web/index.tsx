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
  ModelField,
  pickerModels,
  RepositoryField,
  SessionView,
  useApi,
} from "@pipoca/plugins/web";
import {
  checkoutName,
  type Environment,
  type Profile,
  type ProfileContent,
  profileModel,
  recentPlaces,
  type Session,
} from "@pipoca/protocol";
import {
  Avatar,
  Badge,
  type BadgeState,
  Button,
  buttonClass,
  Card,
  cn,
  Code,
  Dialog,
  type DotTone,
  ErrorText,
  Field,
  Icon,
  linkCardClass,
  Menu,
  Page,
  Picker,
  plural,
  popClass,
  Row,
  Rows,
  Section,
  SessionRow,
  StatusDot,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
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

const teamProjects = "projects";

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
      icon: "star",
      Page: ProjectsPage,
      nav: {
        Items,
        Live: OwnLive,
        fills: (path) => path !== "" && path !== projectList,
        pinned: true,
      },
    },
    {
      path: "team-assistant",
      label: "Team assistant",
      icon: "star",
      Page: TeamAssistant,
      area: "hub",
      nav: { fills: () => true },
    },
    {
      path: teamProjects,
      label: "Projects",
      icon: "folder",
      Page: TeamProjectsPage,
      area: "hub",
      nav: {
        Live: TeamLive,
        Count: TeamCount,
        fills: (path) => path !== "" && path !== projectList,
      },
    },
  ],
  sessionPath: (session) => `${session.plugin?.key ?? ""}/${session.id}`,
  slots: {
    home: Home,
    "notice:thread": ThreadNotice,
    "notice:thread_message": ThreadMessageNotice,
    "notice:coordinator_message": CoordinatorMessageNotice,
    "link:thread": ThreadLink,
    "session.toolCall:projects_create": ProjectCard,
    "session.toolCall:start_thread": StartThreadCard,
    "session.toolCall:message_thread": MessageThreadCard,
  },
});

// A person outside team work gets none of the team's.
async function teamList(api: TypedClient): Promise<ProjectSummary[]> {
  const response = await api.raw("team/projects");

  return response.ok ? ((await response.json()) as ProjectSummary[]) : [];
}

// Team Projects open only in the team's area, wherever the link came from.
function link(path: string, team = false): string {
  return team
    ? `#team/plugin/${projects.id}/${teamProjects}/${path}`
    : pageHref(projects, path);
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

function createdId(call: ToolCall): string | undefined {
  try {
    const { id } = JSON.parse(call.result?.text ?? "") as { id?: unknown };

    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

const creationStates: Partial<Record<ToolCall["status"], string>> = {
  running: "Creating…",
  done: "Created",
};

function ProjectCard({ call }: ToolCallProps): ReactElement {
  const api = useApi(projects);
  const id = call.status === "done" ? createdId(call) : undefined;

  const project = useLoaded(
    async () =>
      id === undefined
        ? undefined
        : api.get<ProjectView>(`projects/${encodeURIComponent(id)}`),
    id ?? "",
    watched,
  ).value;

  const coordinator = useLoaded(
    async () =>
      project === undefined
        ? undefined
        : api.get<Session>(
            `/api/sessions/${encodeURIComponent(project.coordinatorId)}`,
          ),
    project?.coordinatorId ?? "",
  ).value;

  const profiles =
    useLoaded(
      async () =>
        project === undefined
          ? []
          : api.get<Profile[]>(
              project.team ? "/api/profiles?scope=team" : "/api/profiles",
            ),
      project === undefined ? "" : String(project.team),
      { topics: ["profiles"] },
    ).value ?? [];

  const name = project?.name ?? argument(call.args, "name") ?? "Project";

  if (call.status !== "done" || project === undefined) {
    return (
      <Card
        padding="none"
        aria-label={`Project ${name}`}
        className="flex flex-col px-3 py-2"
      >
        <span className="truncate text-label font-medium text-fg-strong">
          {name}
        </span>
        <span
          className={cn(
            "truncate text-caption",
            call.status === "failed" ? "text-failed" : "text-fg-dim",
          )}
        >
          {creationStates[call.status] ?? call.result?.text ?? "Wasn't created"}
        </span>
      </Card>
    );
  }

  const profile = profiles.find((each) =>
    project.profileId === null ? each.isDefault : each.id === project.profileId,
  );

  const thread = project.threads.at(-1);
  const repositories = project.repositories.length;

  return (
    <Card
      padding="none"
      aria-label={`Project ${project.name}`}
      className="flex flex-col"
    >
      <div className="flex items-center gap-3 px-3 py-2">
        <Icon name="git-fork" className="size-4 shrink-0 text-fg-dim" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-2 truncate text-label font-medium text-fg-strong">
            {project.name}
            {project.team && <Badge>Team</Badge>}
          </span>
          <span className="truncate text-caption text-fg-dim">
            {[
              plural(repositories, "repository", "repositories"),
              profile &&
                `Profile: ${profile.name}${profile.isDefault ? " (default)" : ""}`,
              coordinator?.model?.id,
            ]
              .filter((part) => part !== undefined)
              .join(" · ")}
          </span>
        </div>
        <a
          href={link(project.id, project.team)}
          className={buttonClass({ size: "sm" })}
        >
          {project.team ? "Open in Team" : "Open"}
        </a>
      </div>
      <div className="flex items-center gap-3 border-t border-line px-3 py-2">
        <StateDot thread={thread} />
        <span className="min-w-0 flex-1 truncate text-caption text-fg-dim">
          {thread ? (
            <>
              <span className="font-medium text-fg">{thread.title}</span>
              {` · Thread in ${project.name} · ${workStateNames[thread.workState]}`}
            </>
          ) : (
            `Coordinator ${runBadges[project.coordinatorState]?.label.toLowerCase() ?? project.coordinatorState}`
          )}
        </span>
      </div>
    </Card>
  );
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
  return <AssistantItems path={path} />;
}

function tone(project: ProjectSummary): DotTone | undefined {
  if (project.needsYou > 0) {
    return "waiting";
  }

  return project.coordinatorState === "working" ? "working" : undefined;
}

function OwnLive({ path }: NavItemsProps): ReactElement | null {
  return <ActiveProjects path={path} team={false} />;
}

function TeamLive({ path }: NavItemsProps): ReactElement | null {
  return <ActiveProjects path={path} team />;
}

function TeamCount(): ReactElement | null {
  const count = useActive(true)?.length ?? 0;

  return count === 0 ? null : <>{count}</>;
}

function useActive(team: boolean): readonly ProjectSummary[] | undefined {
  const api = useApi(projects);

  return useLoaded(
    async () => (team ? teamList(api) : api.get<ProjectSummary[]>("projects")),
    team ? "team-projects" : "projects",
    watched,
  ).value?.filter(({ coordinatorState }) => coordinatorState !== "archived");
}

// Below the sidebar's entries, the Projects that aren't archived.
function ActiveProjects({
  path,
  team,
}: NavItemsProps & { readonly team: boolean }): ReactElement | null {
  const list = useActive(team);

  if (list === undefined || list.length === 0) {
    return null;
  }

  return (
    <section aria-label="Active Projects" className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-caption font-medium text-fg-dim">
        Active Projects
      </h2>
      <ul
        id={team ? "team-project-nav" : "project-nav"}
        className="flex flex-col gap-0.5"
      >
        {list.map((project) => (
          <li key={project.id}>
            <a
              href={link(project.id, team)}
              aria-current={
                path?.split("/")[0] === project.id ? "page" : undefined
              }
              className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
            >
              <StatusDot tone={tone(project)} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-label font-medium">
                  {project.name}
                </span>
                <span className="truncate text-caption text-fg-dim">
                  {project.needsYou > 0
                    ? `${counted(project.needsYou, "thread needs", "threads need")} ${team ? "someone" : "you"}`
                    : `${counted(project.repositories, "repository", "repositories")} · coordinator ${project.coordinatorState}`}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function counted(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

function TeamProjectsPage({ path }: PageProps): ReactElement {
  return <ProjectsPage path={path} team />;
}

function ProjectsPage({
  path,
  team = false,
}: PageProps & { readonly team?: boolean }): ReactElement {
  const api = useApi(projects);

  const [open = team ? projectList : "", ...rest] = path.split("/");

  const go = (to: string): void => {
    location.hash = link(to, team);
  };

  const environments =
    useLoaded(
      async () =>
        api.get<Environment[]>(
          team ? "/api/environments?scope=team" : "/api/environments",
        ),
      team ? "team-environments" : "environments",
      { topics: ["environments"] },
    ).value ?? [];

  if (open === earlier) {
    return <Earlier path={rest.join("/")} />;
  }

  if (open === "") {
    return <Opening />;
  }

  return open === projectList ? (
    <ProjectList environments={environments} team={team} onOpen={go} />
  ) : (
    <ProjectPage
      key={open}
      id={open}
      rest={rest.join("/")}
      team={team}
      environments={environments}
    />
  );
}

function ProjectList({
  environments,
  team,
  onOpen,
}: {
  readonly environments: readonly Environment[];
  readonly team: boolean;
  readonly onOpen: (id: string) => void;
}): ReactElement {
  const api = useApi(projects);
  const [creating, setCreating] = useState(false);

  const list = useLoaded(
    async () => (team ? teamList(api) : api.get<ProjectSummary[]>("projects")),
    team ? "team-projects" : "projects",
    watched,
  ).value;

  const others = useLoaded(
    async () => (team ? [] : teamList(api)),
    team ? "no-team-projects" : "team-projects",
    watched,
  ).value;

  const teamName =
    useLoaded(
      async () =>
        (await api.get<{ name: string | null }>("/api/settings/team")).name,
      "team-name",
      { topics: ["settings"] },
    ).value ?? "the team";

  const active = list?.filter(
    ({ coordinatorState }) => coordinatorState !== "archived",
  );

  const archived = list?.filter(
    ({ coordinatorState }) => coordinatorState === "archived",
  );

  return (
    <Page
      title={team ? "Team Projects" : "Your Projects"}
      description={
        team
          ? "Everyone on the team can see and steer these."
          : "Projects only you work on."
      }
      actions={
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true);
          }}
        >
          {team ? "New team Project" : "New Project"}
        </Button>
      }
    >
      {active?.length === 0 && <p className="text-fg-dim">No Projects yet.</p>}
      <ProjectRows projects={active ?? []} onOpen={onOpen} />
      {others !== undefined && others.length > 0 && (
        <a
          href={link(projectList, true)}
          className={cn(
            linkCardClass,
            "mt-4 flex items-center gap-3.5 px-4 py-3.5 no-underline hover:bg-hover",
          )}
        >
          <Avatar name="Team" square size="md">
            Te
          </Avatar>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="font-medium text-fg-strong">
              {counted(others.length, "team Project", "team Projects")}
            </span>
            <span className="truncate text-caption text-fg-dim">
              {others.map(({ name }) => name).join(", ")} · in the {teamName}{" "}
              workspace
            </span>
          </span>
          <span className="text-caption text-fg-dim">
            Switch to {teamName} →
          </span>
        </a>
      )}
      {archived !== undefined && archived.length > 0 && (
        <Section title="Archived">
          <ProjectRows projects={archived} onOpen={onOpen} />
        </Section>
      )}
      <Dialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        title={team ? "New team Project" : "New Project"}
        description={
          team
            ? "Everyone on the team can see and steer it."
            : "Only you work on it."
        }
        sheet
      >
        {creating && (
          <CreateForm
            environments={environments}
            team={team}
            onCreated={onOpen}
            onCancel={() => {
              setCreating(false);
            }}
          />
        )}
      </Dialog>
    </Page>
  );
}

function ProjectRows({
  projects: shown,
  onOpen,
}: {
  readonly projects: readonly ProjectSummary[];
  readonly onOpen: (id: string) => void;
}): ReactElement | null {
  if (shown.length === 0) {
    return null;
  }

  return (
    <Rows>
      {shown.map((project) => (
        <Row
          key={project.id}
          className="relative hover:bg-hover"
          initials={Array.from(project.name).slice(0, 2).join("")}
          title={
            <button
              type="button"
              onClick={() => {
                onOpen(project.id);
              }}
              className="cursor-pointer text-left after:absolute after:inset-0"
            >
              {project.name}
            </button>
          }
          description={`${counted(project.repositories, "repository", "repositories")} · ${
            project.coordinatorState === "archived"
              ? "archived"
              : counted(project.threads, "thread", "threads")
          }`}
        >
          {project.needsYou > 0 && (
            <Badge state="waiting">{project.needsYou} needs you</Badge>
          )}
        </Row>
      ))}
    </Rows>
  );
}

function useProfiles(team: boolean): readonly Profile[] {
  const api = useApi(projects);

  return (
    useLoaded(
      async () =>
        api.get<Profile[]>(team ? "/api/profiles?scope=team" : "/api/profiles"),
      team ? "team-profiles" : "profiles",
      { topics: ["profiles"] },
    ).value ?? []
  );
}

// The Profile a Project's work runs with, its default marked. Team work has
// no "default" choice of its own: the team default comes preselected.
function ProfileField({
  profiles,
  team,
  shown,
  onChange,
}: {
  readonly profiles: readonly Profile[];
  readonly team: boolean;
  readonly shown: Profile | undefined;
  readonly onChange: (id: string) => void;
}): ReactElement {
  return (
    <Picker
      label="Profile"
      options={[
        ...(team ? [] : [{ value: "", label: "The default Profile" }]),
        ...profiles.map(({ id, name, isDefault }) => ({
          value: id,
          label: name,
          ...(isDefault && {
            detail: team ? "team default" : "default",
          }),
        })),
      ]}
      selected={[shown?.id ?? ""]}
      onChange={([id]) => {
        onChange(id ?? "");
      }}
    >
      {profileLabel(shown, team)}
    </Picker>
  );
}

function profileLabel(profile: Profile | undefined, team: boolean): string {
  if (profile === undefined) {
    return "The default Profile";
  }

  if (!profile.isDefault) {
    return profile.name;
  }

  return `${profile.name} · ${team ? "team default" : "default"}`;
}

// A name, the repositories and a goal, with the Profile and model
// preselected to the defaults; the rest takes its defaults and is changed
// behind the Project's gear (ADR 0040).
function CreateForm({
  environments,
  team,
  onCreated,
  onCancel,
}: {
  readonly environments: readonly Environment[];
  readonly team: boolean;
  readonly onCreated: (id: string) => void;
  readonly onCancel: () => void;
}): ReactElement {
  const api = useApi(projects);

  const sessions =
    useLoaded(
      async () =>
        api.get<Session[]>(team ? "/api/sessions?scope=team" : "/api/sessions"),
      team ? "team-sessions" : "sessions",
      { topics: ["sessions"] },
    ).value ?? [];

  const profiles = useProfiles(team);

  const under =
    useLoaded(
      async () =>
        Promise.all([
          ...(team
            ? []
            : [api.get<ProfileContent>("/api/me/profile-defaults")]),
          api.get<ProfileContent>("/api/settings/base-profile"),
        ]),
      team ? "team-layers" : "layers",
      { topics: ["profiles"] },
    ).value ?? [];

  const [repositories, setRepositories] = useState<readonly string[]>([]);
  const [environment, setEnvironment] = useState("");
  const [profile, setProfile] = useState("");
  const [model, setModel] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const offered = environments;
  const chosen = offered.find(({ id }) => id === environment);
  const runsOn = chosen ?? offered[0];

  const fallback =
    profiles.find(({ isDefault }) => isDefault) ??
    (team ? profiles[0] : undefined);

  const profileShown = profiles.find(({ id }) => id === profile) ?? fallback;

  const models = pickerModels(runsOn?.models ?? [], {
    hidden: runsOn?.hiddenModels ?? [],
    unavailable: runsOn?.unavailableModels ?? [],
  });

  const starting = model || profileModel(profileShown, profiles, under);
  const picked = models.find(({ value }) => value === starting);
  const defaultModel = team ? "Team default" : "Default model";

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (creating) {
      return;
    }

    const data = new FormData(event.currentTarget);

    const field = (name: string): string => {
      const value = data.get(name);

      return typeof value === "string" ? value.trim() : "";
    };

    setCreating(true);
    setError(undefined);

    api
      .post<ProjectView>(team ? "team/projects" : "projects", {
        name: field("name"),
        goal: field("goal"),
        repositories,
        environment: runsOn?.id ?? "",
        ...(model !== "" && { model }),
        ...(profileShown && { profile: profileShown.id }),
        ...(field("first") !== "" && { firstMessage: field("first") }),
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
    <form onSubmit={submit} className="project-create flex flex-col">
      <div className="grid gap-4 px-6 pb-5">
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
        <div className="flex flex-col gap-1.5">
          <span className="text-label font-medium text-fg-strong">
            Repositories
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <RepositoryField
              label="Repositories"
              selected={repositories}
              recent={recentPlaces(sessions, runsOn?.id)}
              team={team}
              hint={
                team
                  ? "Only repositories the team's bots reach."
                  : "Only repositories your logins reach."
              }
              onChange={setRepositories}
            >
              {repositories.length === 0 ? (
                <span className="text-fg-dim">Add repositories</span>
              ) : (
                repositories
                  .map((repository) => checkoutName(repository) ?? repository)
                  .join(", ")
              )}
            </RepositoryField>
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
                  setModel("");
                }}
              >
                <span className="text-fg-dim">on </span>
                {runsOn?.name}
              </Picker>
            )}
          </div>
          <p className="text-caption text-fg-dim">
            Each repository is checked out for the coordinator and its threads.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-fg-strong">
              Profile
            </span>
            <ProfileField
              profiles={profiles}
              team={team}
              shown={profileShown}
              onChange={setProfile}
            />
            <p className="text-caption text-fg-dim">
              {team
                ? "Preselected. Only team Profiles are listed."
                : "Preselected to your default."}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium text-fg-strong">Model</span>
            <ModelField
              label="Model"
              models={models}
              selected={model}
              none={defaultModel}
              onPick={setModel}
            >
              {picked === undefined
                ? (starting ?? defaultModel)
                : `${picked.name ?? picked.id} · ${picked.providerName}`}
            </ModelField>
            <p className="text-caption text-fg-dim">
              {team
                ? `${model === "" ? "Team default, with" : "With"} the team's keys.`
                : "The Profile's model unless you pick one."}
            </p>
          </div>
        </div>
        <Field label="First message to the coordinator">
          <TextArea
            name="first"
            rows={3}
            placeholder="Optional. Without one, the coordinator waits for you."
          />
        </Field>
        <ErrorText size="caption">{error}</ErrorText>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-6 py-4">
        <span className="flex-1 text-caption text-fg-dim">
          Opens in {team ? "Team › Projects" : "Projects"}
        </span>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="submit"
          disabled={creating || repositories.length === 0}
        >
          Create Project
        </Button>
      </div>
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
  team,
  environments,
}: {
  readonly id: string;
  readonly rest: string;
  readonly team: boolean;
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

  const elsewhere =
    project && project.team !== team
      ? link(rest === "" ? id : `${id}/${rest}`, project.team)
      : undefined;

  useEffect(() => {
    if (elsewhere !== undefined) {
      location.replace(elsewhere);
    }
  }, [elsewhere]);

  if (project === undefined || elsewhere !== undefined) {
    return <div className="flex-1" />;
  }

  if (project === null) {
    return (
      <div className="m-auto flex flex-col items-center gap-3 p-8">
        <p className="text-fg-dim">Project not found.</p>
        <a href={link("", team)} className="text-accent hover:underline">
          All Projects
        </a>
      </div>
    );
  }

  const panel = panelOf(rest, project);

  const to = (where: string): string =>
    link(where === "" ? id : `${id}/${where}`, project.team);

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
          className={cn(column, "w-[min(52rem,58%)] bg-bg")}
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
            <Settings
              path={path}
              project={project}
              onSaved={reload}
              environment={
                environments.find(
                  (each) => each.id === project.environmentId,
                ) ?? environments[0]
              }
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
  environment,
}: {
  readonly path: string;
  readonly project: ProjectView;
  readonly onSaved: () => void;
  readonly environment: Environment | undefined;
}): ReactElement {
  const api = useApi(projects);
  const profiles = useProfiles(project.team);

  const models = pickerModels(environment?.models ?? [], {
    hidden: environment?.hiddenModels ?? [],
    unavailable: environment?.unavailableModels ?? [],
  });

  const saved = {
    name: project.name,
    goal: project.goal,
    threadModel: project.threadModel ?? "",
    profile: project.profileId ?? "",
    instructions: project.instructions,
  };

  const [draft, setDraft] = useState(saved);
  const [repositories, setRepositories] = useState(project.repositories);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const moved =
    repositories.length !== project.repositories.length ||
    repositories.some((each, at) => each !== project.repositories[at]);

  const changed =
    moved ||
    (Object.keys(saved) as (keyof typeof saved)[]).some(
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
          .post(`${path}/settings`, {
            ...draft,
            ...(moved && { repositories }),
          })
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
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-medium text-fg-strong">
          Repositories
        </span>
        <div>
          <RepositoryField
            label="Repositories"
            selected={repositories}
            recent={project.repositories}
            team={project.team}
            hint={
              project.team
                ? "Only repositories the team's bots reach."
                : "Only repositories your logins reach."
            }
            onChange={setRepositories}
          >
            {repositories.length === 0 ? (
              <span className="text-fg-dim">Add repositories</span>
            ) : (
              repositories
                .map((repository) => checkoutName(repository) ?? repository)
                .join(", ")
            )}
          </RepositoryField>
        </div>
        {moved && (
          <p className="text-caption text-fg-dim">
            Saving starts the coordinator afresh with these checked out.
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-medium text-fg-strong">
          Thread model
        </span>
        <div>
          <ModelField
            label="Thread model"
            models={models}
            selected={draft.threadModel}
            none="The coordinator's model"
            onPick={(threadModel) => {
              setDraft({ ...draft, threadModel });
            }}
          >
            {models.find(({ value }) => value === draft.threadModel)?.name ??
              (draft.threadModel || "The coordinator's model")}
          </ModelField>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-label font-medium text-fg-strong">Profile</span>
        <div>
          <ProfileField
            profiles={profiles}
            team={project.team}
            shown={
              profiles.find(({ id }) => id === draft.profile) ??
              (project.team
                ? profiles.find(({ isDefault }) => isDefault)
                : undefined)
            }
            onChange={(profile) => {
              setDraft({ ...draft, profile });
            }}
          />
        </div>
      </div>
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
