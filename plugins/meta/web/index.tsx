import {
  type HomeProps,
  json,
  modelOptions,
  type NavItemsProps,
  type PageProps,
  rememberModel,
  useLoaded,
  type WebContext,
  type WebPlugin,
} from "@pipoca/plugins/web";
import type { Environment, ModelRef, Session } from "@pipoca/protocol";
import { Button, cn, Icon, isComposing, PageTitle, Picker } from "@pipoca/ui";
import {
  type ReactElement,
  type SubmitEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

// Fired when a new meta-session starts, so every list shows it at once.
const started = new EventTarget();

const modelKey = "pipoca.meta.model";

// The assistant is a Project of the person's own, with this plugin's
// Profiles for its coordinator and threads (ADR 0052).
const assistantPath = "/api/ext/projects/assistant";

export const meta: WebPlugin = {
  name: "meta",
  nav: { label: "Assistant", Page, Items, fills: (path) => path !== "" },
  sessionPath: (session) => session.id,
  Home,
  hub: {
    pages: { assistant: { label: "Team assistant", Page: TeamAssistant } },
  },
};

function useMetaSessions(
  context: WebContext,
  load = async (): Promise<Session[]> =>
    json<Session[]>(context.request("sessions")),
): readonly Session[] {
  const { value, reload } = useLoaded(load, "sessions", {
    topics: ["sessions"],
  });

  useEffect(() => {
    started.addEventListener("started", reload);

    return () => {
      started.removeEventListener("started", reload);
    };
  }, [reload]);

  return value ?? [];
}

function titleOf(session: Session): string {
  return session.title ?? session.firstMessage ?? "Untitled";
}

function Home({ context, onNewSession }: HomeProps): ReactElement {
  // Once the assistant exists, its own chat switches models.
  const assistant = useAssistantLoad(context);

  const environments = useLoaded(
    async () => json<Environment[]>(context.request("/api/environments")),
    "environments",
  ).value;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-12 md:py-24">
      <h1 className="text-center font-serif text-hero font-light text-fg-strong">
        What do you want to build today?
      </h1>
      {environments !== undefined && environments.length > 0 && (
        <Composer
          context={context}
          models={modelNames(environments)}
          picksModel={typeof assistant !== "string"}
        />
      )}
      <Continue assistant={assistant} />
      <div className="flex justify-center">
        <Button variant="ghost" onClick={onNewSession}>
          <Icon name="plus" />
          Start a session yourself
        </Button>
      </div>
      {assistant === null && <Recent context={context} />}
    </div>
  );
}

// The list is only extra on the home screen, so a failed load leaves it out
// instead of taking the composer down with it.
function Recent({ context }: { readonly context: WebContext }): ReactElement {
  const sessions = useMetaSessions(context, async () =>
    json<Session[]>(context.request("sessions")).catch(() => []),
  );

  if (sessions.length === 0) {
    return <></>;
  }

  return (
    <section aria-labelledby="recent-meta" className="flex flex-col gap-2">
      <h2 id="recent-meta" className="text-label font-medium text-fg-dim">
        Earlier conversations
      </h2>
      <ul className="flex flex-col gap-0.5">
        {sessions.slice(0, 8).map((session) => (
          <li key={session.id}>
            <a
              href={context.href(session.id)}
              className="block truncate rounded-md px-3 py-2 text-fg hover:bg-hover"
            >
              {titleOf(session)}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Composer({
  context,
  models,
  picksModel,
  team = false,
}: {
  readonly context: WebContext;
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

    ask(context, text, ref, team).then(
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
          <p role="alert" className="flex-1 text-caption text-failed">
            {error}
          </p>
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

// Without the Projects plugin, an ask starts a meta-session as before.
async function ask(
  context: WebContext,
  text: string,
  model: ModelRef | undefined,
  team: boolean,
): Promise<string> {
  const response = await context.request(assistantPath, {
    method: "POST",
    body: JSON.stringify({
      text,
      ...(model && { model: `${model.provider}/${model.id}` }),
      profile: "meta.assistant",
      threadProfile: "meta.builder",
      ...(team && { team }),
    }),
  });

  if (response.status !== 404 || team) {
    const project = await json<{ id: string }>(Promise.resolve(response));

    return projectHref(project.id);
  }

  const session = await json<Session>(
    context.request("sessions", {
      method: "POST",
      body: JSON.stringify({ text, ...(model && { model }) }),
    }),
  );

  started.dispatchEvent(new Event("started"));

  return context.href(session.id);
}

function projectHref(id: string): string {
  return `#plugin/projects/${encodeURIComponent(id)}`;
}

// The person's assistant Project, or undefined before their first ask.
function useAssistant(context: WebContext): string | undefined {
  return useAssistantLoad(context) ?? undefined;
}

// Undefined while loading, null when the person has no assistant yet.
function useAssistantLoad(context: WebContext): string | null | undefined {
  return useLoaded(
    async () => {
      const response = await context.request(assistantPath);

      return response.ok
        ? (await json<{ id: string }>(Promise.resolve(response))).id
        : null;
    },
    "assistant",
    { topics: ["projects.projects"] },
  ).value;
}

// Each person's Team assistant, opened only from the team hub. Its chat is
// theirs alone, and what it starts belongs to the team (ADR 0067).
function TeamAssistant({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  const { SessionView } = context;

  const project = useLoaded(
    async () => {
      const response = await context.request(`${assistantPath}?team=true`);

      return response.ok
        ? await json<{ coordinatorId: string }>(Promise.resolve(response))
        : null;
    },
    "team-assistant",
    { topics: ["projects.projects"] },
  ).value;

  const environments = useLoaded(
    async () =>
      json<Environment[]>(context.request("/api/environments?scope=team")),
    "team-environments",
    { topics: ["environments"] },
  ).value;

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
      {environments !== undefined && environments.length > 0 ? (
        <Composer
          context={context}
          models={modelNames(environments)}
          picksModel
          team
        />
      ) : (
        <p className="text-fg-dim">
          An admin has to set up a team Environment first.
        </p>
      )}
    </div>
  );
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
      <a href={projectHref(assistant)} className="text-accent hover:underline">
        Continue with the assistant
      </a>
    </div>
  );
}

// Meta-sessions from before the assistant was a Project stay reachable,
// behind one link, once it is.
const earlier = "earlier";

function Items({ context, path }: NavItemsProps): ReactElement {
  const sessions = useMetaSessions(context);
  const assistant = useAssistant(context);

  if (assistant !== undefined) {
    return sessions.length === 0 ? (
      <></>
    ) : (
      <ul className="flex flex-col gap-0.5">
        <li>
          <a
            href={context.href(earlier)}
            aria-current={path === earlier ? "page" : undefined}
            className="block truncate rounded-md py-1.5 pr-2 pl-10.5 text-label text-fg-dim hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
          >
            Earlier conversations
          </a>
        </li>
      </ul>
    );
  }

  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.slice(0, 5).map((session) => (
        <li key={session.id}>
          <a
            href={context.href(session.id)}
            aria-current={path === session.id ? "page" : undefined}
            className="block truncate rounded-md py-1.5 pr-2 pl-10.5 text-label text-fg hover:bg-hover aria-[current=page]:bg-hover aria-[current=page]:text-fg-strong"
          >
            {titleOf(session)}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Page({ context, path }: PageProps): ReactElement {
  if (path === "") {
    return <Opening context={context} />;
  }

  if (path === earlier) {
    return <Conversations context={context} />;
  }

  return (
    <context.SessionView
      sessionId={path}
      layout="full"
      crumb={
        <a href={context.href("")} className="text-fg-dim hover:text-fg">
          Assistant
        </a>
      }
    />
  );
}

// The Assistant entry opens the person's assistant Project once it exists.
function Opening({ context }: { readonly context: WebContext }): ReactElement {
  const assistant = useAssistantLoad(context);

  useEffect(() => {
    if (typeof assistant === "string") {
      location.replace(projectHref(assistant));
    }
  }, [assistant]);

  return assistant === null ? <Conversations context={context} /> : <></>;
}

function Conversations({
  context,
}: {
  readonly context: WebContext;
}): ReactElement {
  const sessions = useMetaSessions(context);
  const assistant = useAssistantLoad(context);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-display font-semibold text-fg-strong">Assistant</h1>
      <Continue assistant={assistant} />
      {sessions.length === 0 ? (
        <p className="text-fg-dim">
          Conversations with the Pipoca assistant show here.{" "}
          <a href="#" className="text-accent">
            Start one
          </a>
          .
        </p>
      ) : (
        <ul className={cn("flex flex-col gap-0.5")}>
          {sessions.map((session) => (
            <li key={session.id}>
              <a
                href={context.href(session.id)}
                className="block truncate rounded-md px-3 py-2 text-fg hover:bg-hover"
              >
                {titleOf(session)}
              </a>
            </li>
          ))}
        </ul>
      )}
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
