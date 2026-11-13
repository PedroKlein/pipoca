import {
  href,
  ModelField,
  pickerModels,
  SessionView,
  useLoaded,
  useApi,
} from "@pipoca/plugins/web";
import { type Environment, modelRefOf, type Session } from "@pipoca/protocol";
import {
  Button,
  ErrorText,
  Icon,
  isComposing,
  Page,
  type PickerModel,
} from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { TypedClient } from "@pipoca/plugins";
import { projects } from "../plugin";
import type { ProjectSummary, ProjectView } from "../src/model";

// Team work runs on team Environments, whose models differ from a person's.
const modelKeys = {
  own: "pipoca.projects.model",
  team: "pipoca.projects.team-model",
};

// Earlier conversations: the coordinators a fresh one replaced.
export const earlier = "earlier";

// The Project list, under the Assistant entry.
export const projectList = "all";

// Each person's assistant is a Project of their own, and the Team assistant
// one each person has for team work (ADR 0052, ADR 0067). Undefined while
// loading, null before the person's first ask.
function useAssistant(team = false): ProjectView | null | undefined {
  const api = useApi(projects);

  return useLoaded(
    async () => {
      const response = await api.raw(team ? "team/assistant" : "assistant");

      return response.ok ? ((await response.json()) as ProjectView) : null;
    },
    team ? "team-assistant" : "assistant",
    { changes: ["projects"] },
  ).value;
}

// Undefined while loading, null when there is no Environment to run on.
function useModels(
  scope: "" | "team",
): readonly PickerModel[] | null | undefined {
  const api = useApi(projects);

  const environments = useLoaded(
    async () =>
      api.get<Environment[]>(
        scope === "team" ? "/api/environments?scope=team" : "/api/environments",
      ),
    `environments-${scope}`,
    { topics: ["environments"] },
  ).value;

  return (
    environments &&
    (environments.length === 0
      ? null
      : pickerModels(
          environments.flatMap(({ models }) => models),
          {
            hidden: environments.flatMap(({ hiddenModels }) => hiddenModels),
            unavailable: environments.flatMap(
              ({ unavailableModels }) => unavailableModels,
            ),
          },
        ))
  );
}

// The home screen asks the assistant. Once it exists, its own chat switches
// models.
export function Home({
  onNewSession,
}: {
  readonly onNewSession: () => void;
}): ReactElement {
  const assistant = useAssistant();
  const models = useModels("");

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12 md:py-24">
      <h1 className="text-center font-serif text-hero font-light text-fg-strong">
        What do you want to build today?
      </h1>
      {models !== undefined && models !== null && (
        <Composer models={models} picksModel={assistant === null} />
      )}
      <Continue assistant={assistant === null ? null : assistant?.id} />
      {assistant !== null &&
        assistant !== undefined &&
        assistant.formerCoordinators.length > 0 && (
          <div className="flex justify-center">
            <a
              href={href(projects, earlier)}
              className="text-label text-fg-dim hover:underline"
            >
              Earlier conversations
            </a>
          </div>
        )}
      <div className="flex justify-center">
        <Button variant="ghost" onClick={onNewSession}>
          <Icon name="plus" />
          Start a session yourself
        </Button>
      </div>
    </div>
  );
}

// The sidebar's Assistant entry opens the person's one assistant, and asks
// it the first thing before it exists (ADR 0052).
export function Opening(): ReactElement {
  const assistant = useAssistant();
  const models = useModels("");

  useEffect(() => {
    if (assistant) {
      location.replace(href(projects, assistant.id));
    }
  }, [assistant]);

  if (assistant !== null) {
    return <></>;
  }

  return (
    <Page
      title="Assistant"
      description="Ask it to set up Pipoca, start work in your repositories, or build a plugin. It asks before anything destructive."
    >
      {models !== undefined && models !== null ? (
        <Composer models={models} picksModel />
      ) : (
        <p className="text-fg-dim">Set up an Environment first.</p>
      )}
    </Page>
  );
}

// Under the Assistant entry: the Project list, and the assistant's earlier
// conversations once it has some.
export function AssistantItems({
  path,
}: {
  readonly path: string | undefined;
}): ReactElement {
  const assistant = useAssistant();
  const api = useApi(projects);

  const active = useLoaded(
    async () => api.get<ProjectSummary[]>("projects"),
    "projects",
    { topics: ["sessions"], changes: ["projects"] },
  ).value?.filter(({ coordinatorState }) => coordinatorState !== "archived");

  const item = (to: string, label: string): ReactElement => (
    <li>
      <a
        href={href(projects, to)}
        aria-current={path?.split("/")[0] === to ? "page" : undefined}
        className="block truncate rounded-md py-1.5 pr-2 pl-10.5 text-label text-fg-dim hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
      >
        {label}
      </a>
    </li>
  );

  return (
    <ul className="flex flex-col gap-0.5">
      <li>
        <a
          href={href(projects, projectList)}
          aria-current={
            path?.split("/")[0] === projectList ? "page" : undefined
          }
          className="group/nav flex items-center gap-2.5 rounded-md px-2 py-1.5 text-ui text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
        >
          <span
            aria-hidden="true"
            className="grid size-6 place-items-center text-fg-dim group-aria-[current=page]/nav:text-accent"
          >
            <Icon name="folder" />
          </span>
          <span className="flex-1">Projects</span>
          {active !== undefined && active.length > 0 && (
            <span className="text-caption text-fg-dim tabular-nums">
              {active.length}
            </span>
          )}
        </a>
      </li>
      {assistant && assistant.formerCoordinators.length > 0
        ? item(earlier, "Earlier conversations")
        : null}
    </ul>
  );
}

// The assistant's earlier coordinators, newest first, each still readable
// (ADR 0052). path is what follows earlier/ in the address.
export function Earlier({ path }: { readonly path: string }): ReactElement {
  const api = useApi(projects);

  const assistant = useAssistant();

  const sessions = useLoaded(
    async () =>
      Promise.all(
        (assistant?.formerCoordinators ?? []).map(async (id) =>
          api.get<Session>(`/api/sessions/${encodeURIComponent(id)}`),
        ),
      ),
    (assistant?.formerCoordinators ?? []).join(" "),
  ).value;

  const back = (
    <a
      href={assistant ? href(projects, assistant.id) : "#"}
      className="text-fg-dim hover:text-fg"
    >
      Assistant
    </a>
  );

  if (path !== "") {
    return <SessionView sessionId={path} layout="full" crumb={back} />;
  }

  return (
    <Page title="Earlier conversations" className="gap-4">
      <Continue assistant={assistant === null ? null : assistant?.id} />
      {sessions?.length === 0 ? (
        <p className="text-fg-dim">
          When the assistant starts fresh, its earlier conversations show here.
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {(sessions ?? []).toReversed().map((session) => (
            <li key={session.id}>
              <a
                href={href(projects, `${earlier}/${session.id}`)}
                className="block truncate rounded-md px-3 py-2 text-fg hover:bg-hover"
              >
                {session.title ?? session.firstMessage ?? "Untitled"}
              </a>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

// Each person's Team assistant, opened only from the team hub. Its chat is
// theirs alone, and what it starts belongs to the team (ADR 0067).
export function TeamAssistant(): ReactElement {
  const project = useAssistant(true);
  const models = useModels("team");

  if (project === undefined) {
    return <></>;
  }

  if (project !== null) {
    return (
      <SessionView
        sessionId={project.coordinatorId}
        layout="full"
        title="Team assistant"
      />
    );
  }

  // It fills the team area, so it scrolls itself.
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Page
        title="Team assistant"
        description="Ask it to start team work, look up what the team is doing, or set up a routine for the team. Its chat is yours alone; what it starts belongs to the team, on the team's key."
      >
        {models !== undefined && models !== null ? (
          <Composer models={models} picksModel team />
        ) : (
          <p className="text-fg-dim">
            An admin has to set up a team Environment first.
          </p>
        )}
      </Page>
    </div>
  );
}

function Composer({
  models,
  picksModel,
  team = false,
}: {
  readonly models: readonly PickerModel[];
  readonly picksModel: boolean;
  readonly team?: boolean;
}): ReactElement {
  const api = useApi(projects);
  const textId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState(() => remembered(team));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const picked = models.find(({ value }) => value === model);

  const send = (): void => {
    if (text.trim() === "" || sending) {
      return;
    }

    setSending(true);
    setError(undefined);

    const picks = picksModel && modelRefOf(model) !== undefined;

    ask(api, text, picks ? model : undefined, team).then(
      (where) => {
        if (!team) {
          location.hash = where;
        }
      },
      (reason: unknown) => {
        setSending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
        textRef.current?.focus();
      },
    );
  };

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    send();
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-xl border border-line bg-elevated py-3 pr-3 pl-5 shadow-card transition-[border-color,box-shadow] duration-150 focus-within:border-line-focus focus-within:ring-4 focus-within:ring-focus"
    >
      <label htmlFor={textId} className="sr-only">
        Ask the Pipoca assistant
      </label>
      <textarea
        id={textId}
        ref={textRef}
        rows={3}
        value={text}
        readOnly={sending}
        aria-busy={sending}
        placeholder="Set up a Project for my repositories, start a Session that fixes the failing tests…"
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          const forced = event.metaKey || event.ctrlKey;

          if (
            isComposing(event) ||
            event.key !== "Enter" ||
            event.shiftKey ||
            (!forced && matchMedia("(pointer: coarse)").matches)
          ) {
            return;
          }

          event.preventDefault();
          send();
        }}
        className="max-h-80 min-h-18 resize-none field-sizing-content bg-transparent pt-1 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
      />
      <div className="flex items-center gap-2">
        {error === undefined ? (
          <span className="flex-1 truncate text-caption text-fg-dim pointer-coarse:hidden">
            Enter sends · the assistant asks before anything destructive
          </span>
        ) : (
          <ErrorText size="caption" className="flex-1">
            {error}
          </ErrorText>
        )}
        {picksModel && (
          <ModelField
            label="Model"
            quiet
            models={models}
            selected={model}
            none="Default model"
            onPick={(name) => {
              setModel(name);
              remember(team, name);
            }}
          >
            {model === ""
              ? "Default model"
              : (picked?.name ?? model.slice(model.indexOf("/") + 1))}
          </ModelField>
        )}
        <Button
          variant="primary"
          iconOnly
          type="submit"
          aria-label="Send"
          disabled={sending}
          className="ml-auto rounded-full"
        >
          <Icon name="arrow-up" />
        </Button>
      </div>
    </form>
  );
}

async function ask(
  api: TypedClient,
  text: string,
  model: string | undefined,
  team: boolean,
): Promise<string> {
  const project = await api.post<{ id: string }>(
    team ? "team/assistant" : "assistant",
    {
      text,
      ...(model !== undefined && { model }),
    },
  );

  return href(projects, project.id);
}

// Takes the assistant its page loaded, so the link and the page's model
// picker never disagree about whether the assistant exists.
function Continue({
  assistant,
}: {
  readonly assistant: string | null | undefined;
}): ReactElement {
  if (typeof assistant !== "string") {
    return <></>;
  }

  return (
    <div className="flex justify-center">
      <a
        href={href(projects, assistant)}
        className="text-accent hover:underline"
      >
        Continue with the assistant
      </a>
    </div>
  );
}

// The model the user last asked the assistant with, on this browser only.
function remembered(team: boolean): string {
  try {
    return localStorage.getItem(modelKeys[team ? "team" : "own"]) ?? "";
  } catch {
    return "";
  }
}

function remember(team: boolean, model: string): void {
  try {
    localStorage.setItem(modelKeys[team ? "team" : "own"], model);
  } catch {
    // The choice only lasts this visit.
  }
}
