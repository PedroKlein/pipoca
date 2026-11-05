import {
  href,
  json,
  modelOptions,
  rememberModel,
  SessionView,
  useLoaded,
} from "@pipoca/plugins/web";
import type { Environment, ModelRef, Session } from "@pipoca/protocol";
import {
  Button,
  ErrorText,
  Icon,
  isComposing,
  PageTitle,
  Picker,
} from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useId,
  useRef,
  useState,
} from "react";
import { projects } from "../plugin";
import type { ProjectView } from "../src/model";

const modelKey = "pipoca.projects.model";

// Each person's assistant is a Project of their own, and the Team assistant
// one each person has for team work (ADR 0052, ADR 0067).
const assistantPath = `/api/ext/${projects.id}/assistant`;
const teamAssistantPath = `/api/ext/${projects.id}/team/assistant`;

// Earlier conversations: the coordinators a fresh one replaced.
export const earlier = "earlier";

// Undefined while loading, null before the person's first ask.
function useAssistant(team = false): ProjectView | null | undefined {
  return useLoaded(
    async () => {
      const response = await fetch(team ? teamAssistantPath : assistantPath);

      return response.ok ? ((await response.json()) as ProjectView) : null;
    },
    team ? "team-assistant" : "assistant",
    { changes: ["projects"] },
  ).value;
}

// Undefined while loading, null when there is no Environment to run on.
function useModels(scope: "" | "team"): readonly string[] | null | undefined {
  const environments = useLoaded(
    async () =>
      json<Environment[]>(
        fetch(
          scope === "team"
            ? "/api/environments?scope=team"
            : "/api/environments",
        ),
      ),
    `environments-${scope}`,
    { topics: ["environments"] },
  ).value;

  return (
    environments &&
    (environments.length === 0 ? null : modelNames(environments))
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

// The assistant's earlier coordinators, newest first, each still readable
// (ADR 0052). path is what follows earlier/ in the address.
export function Earlier({ path }: { readonly path: string }): ReactElement {
  const assistant = useAssistant();

  const sessions = useLoaded(
    async () =>
      Promise.all(
        (assistant?.formerCoordinators ?? []).map(async (id) =>
          json<Session>(fetch(`/api/sessions/${encodeURIComponent(id)}`)),
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
    <div className="flex flex-col gap-4">
      <h1 className="text-display font-semibold text-fg-strong">
        Earlier conversations
      </h1>
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
    </div>
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

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-12">
      <PageTitle description="Ask it to start team work, look up what the team is doing, or set up a routine for the team. Its chat is yours alone; what it starts belongs to the team, on the team's key.">
        Team assistant
      </PageTitle>
      {models !== undefined && models !== null ? (
        <Composer models={models} picksModel team />
      ) : (
        <p className="text-fg-dim">
          An admin has to set up a team Environment first.
        </p>
      )}
    </div>
  );
}

function Composer({
  models,
  picksModel,
  team = false,
}: {
  readonly models: readonly string[];
  readonly picksModel: boolean;
  readonly team?: boolean;
}): ReactElement {
  const textId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [model, setModel] = useState(remembered);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const { options, openGroups } = modelOptions(
    [...new Set([model, ...models])].flatMap((name) => {
      const ref = modelRef(name);

      return ref ? [ref] : [];
    }),
  );

  const send = (): void => {
    if (text.trim() === "" || sending) {
      return;
    }

    setSending(true);
    setError(undefined);

    const ref = picksModel ? modelRef(model) : undefined;

    ask(text, ref, team).then(
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
          <Picker
            label="Model"
            quiet
            options={[{ value: "", label: "Default model" }, ...options]}
            {...(openGroups && { openGroups })}
            selected={[model]}
            {...(models.length > 6 && { placeholder: "Search models" })}
            onChange={([name = ""]) => {
              setModel(name);
              remember(name);

              if (name !== "") {
                rememberModel(name);
              }
            }}
          >
            {model === ""
              ? "Default model"
              : model.slice(model.indexOf("/") + 1)}
          </Picker>
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
  text: string,
  model: ModelRef | undefined,
  team: boolean,
): Promise<string> {
  const project = await json<{ id: string }>(
    fetch(team ? teamAssistantPath : assistantPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        ...(model && { model: `${model.provider}/${model.id}` }),
      }),
    }),
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

function modelNames(environments: readonly Environment[]): string[] {
  return [
    ...new Set(
      environments.flatMap(({ models }) =>
        models.map(({ provider, id }) => `${provider}/${id}`),
      ),
    ),
  ];
}

function modelRef(name: string): ModelRef | undefined {
  const slash = name.indexOf("/");

  return slash > 0 && slash < name.length - 1
    ? { provider: name.slice(0, slash), id: name.slice(slash + 1) }
    : undefined;
}

// The model the user last asked the assistant with, on this browser only.
function remembered(): string {
  try {
    return localStorage.getItem(modelKey) ?? "";
  } catch {
    return "";
  }
}

function remember(model: string): void {
  try {
    localStorage.setItem(modelKey, model);
  } catch {
    // The choice only lasts this visit.
  }
}
