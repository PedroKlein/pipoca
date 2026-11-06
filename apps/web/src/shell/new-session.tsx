import { modelOptions, rememberModel, shownModels } from "../models";
import {
  availability,
  type ApiInput,
  type RepositoryChoice,
  thinkingLevels,
} from "@pipoca/protocol";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorText,
  Icon,
  isComposing,
  Picker,
  Segmented,
  Slider,
} from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { request } from "../data/client";
import { useAction, useMe, useQuery } from "../data/hooks";
import { href, navigate } from "../router";
import { modelRef } from "../names";
import { searchRepositories } from "../plugins";
import {
  searchDelayMs,
  type Choices,
  remembered,
  remember,
  isRepository,
  lastSegment,
  workspaceRequest,
  recentPlaces,
  placeOption,
} from "./workspace";

export function NewSessionDialog({
  open,
  team = false,
  onClose,
}: {
  readonly open: boolean;
  // Starts on team work, on the team's Environments and Profiles
  // (ADR 0064).
  readonly team?: boolean;
  readonly onClose: () => void;
}): ReactElement {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="new-session-title"
      size="lg"
      sheet
      initialFocus="textarea"
    >
      <Starter team={team} onClose={onClose} />
    </Dialog>
  );
}

// On a server with a team, whose work it is switches between the person's
// own and the team's, which the team owns (ADR 0064).
function Starter({
  team,
  onClose,
}: {
  readonly team: boolean;
  readonly onClose: () => void;
}): ReactElement {
  const [forTeam, setForTeam] = useState(team);
  const hasTeam = useMe().team;

  const header = (
    <header className="flex flex-col gap-2 pt-3 pr-3 pb-1 pl-5">
      <div className="flex items-center gap-2">
        <h2
          id="new-session-title"
          className="flex-1 text-ui font-semibold text-fg-strong"
        >
          {forTeam ? "Start team work" : "New session"}
        </h2>
        <Button variant="ghost" iconOnly aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </Button>
      </div>
      {hasTeam && (
        <Segmented
          label="Whose work"
          value={forTeam ? "team" : "mine"}
          options={[
            { value: "mine", label: "Just me" },
            { value: "team", label: "The team" },
          ]}
          onChange={(whose) => {
            setForTeam(whose === "team");
          }}
        />
      )}
    </header>
  );

  return forTeam ? (
    <TeamForm onStarted={onClose}>{header}</TeamForm>
  ) : (
    <OwnForm onStarted={onClose}>{header}</OwnForm>
  );
}

function OwnForm({
  onStarted,
  children,
}: {
  readonly onStarted: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <NewSessionForm
      placeholder="What should Pi do? Leave it empty to start idle."
      onStarted={onStarted}
    >
      {children}
    </NewSessionForm>
  );
}

function TeamForm({
  onStarted,
  children,
}: {
  readonly onStarted: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <NewSessionForm
      team
      placeholder="What should the team's Pi do? Anyone on the team can follow it."
      onStarted={onStarted}
    >
      {children}
    </NewSessionForm>
  );
}

// The composer that starts a Session: what Pi should do, where, and with
// which model and Profile.
export function NewSessionForm({
  team = false,
  placeholder,
  onStarted,
  children,
}: {
  readonly team?: boolean;
  readonly placeholder: string;
  readonly onStarted: () => void;
  readonly children?: ReactNode;
}): ReactElement {
  const scope = team ? { query: { scope: "team" } as const } : undefined;
  const environments = useQuery("environments.list", scope).data ?? [];
  const profiles = useQuery("profiles.list", scope).data ?? [];

  const sessions =
    useQuery("sessions.list", {
      query: team ? { scope: "team" } : { archived: false, plugins: true },
    }).data ?? [];

  const message = useRef<HTMLTextAreaElement>(null);
  const [choices, setChoices] = useState(() => remembered(team));
  const [text, setText] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const [invalid, setInvalid] = useState<string>();

  const start = useAction(async (body: ApiInput<"sessions.create">["body"]) => {
    const started = await request("sessions.create", { body });

    setText("");
    setStartPoint("");
    onStarted();
    navigate(href("session", { id: started.id }));
  });

  const submitting = start.pending;

  const error =
    invalid ??
    (start.error === undefined
      ? undefined
      : `Couldn't start the session. ${start.error}`);

  const setError = (reason: string): void => {
    start.clear();
    setInvalid(reason);
  };

  const [found, setFound] = useState<readonly RepositoryChoice[]>([]);
  const searches = useRef(0);

  // Only the latest search's answer is shown, whichever arrives first.
  const search = (query: string): void => {
    const ticket = ++searches.current;

    setTimeout(
      () => {
        if (ticket !== searches.current) {
          return;
        }

        void searchRepositories(query, team).then((repositories) => {
          if (ticket === searches.current) {
            setFound(repositories);
          }
        });
      },
      query === "" ? 0 : searchDelayMs,
    );
  };

  const opened = useEffectEvent(() => {
    search("");
  });

  useEffect(() => {
    opened();
  }, []);

  const choose = (change: Partial<Choices>): void => {
    setChoices((current) => ({ ...current, ...change }));
  };

  const chosen =
    environments.find(({ id }) => id === choices.environment) ??
    environments[0];

  const profile =
    profiles.find(({ id }) => id === choices.profile) ??
    profiles.find(({ isDefault }) => isDefault) ??
    (team ? profiles[0] : undefined);

  const recent = recentPlaces(sessions, chosen?.id);

  const places = [
    ...recent.map((where) => placeOption(where, "Recent")),
    ...(chosen?.folders ?? [])
      .filter((folder) => !recent.includes(folder))
      .map((folder) => placeOption(folder, `On ${chosen?.name ?? ""}`)),
    ...choices.where
      .filter(
        (where) =>
          !recent.includes(where) &&
          !(chosen?.folders.includes(where) ?? false),
      )
      .map((where) => placeOption(where, "Picked")),
  ];

  const offered = [
    ...places,
    ...found
      .filter(({ url }) => !places.some(({ value }) => value === url))
      .map(({ url, name, group }) => ({
        value: url,
        label: name,
        detail: URL.parse(url)?.host ?? url,
        group,
      })),
  ];

  const { options: modelChoices, openGroups } = modelOptions(
    shownModels(chosen?.models ?? [], chosen?.hiddenModels ?? []),
  );

  const sharing =
    choices.share &&
    choices.where.length === 1 &&
    !choices.where.some(isRepository);

  const submit = (event?: SubmitEvent<HTMLFormElement>): void => {
    event?.preventDefault();

    if (submitting) {
      return;
    }

    if (choices.where.length === 0) {
      setError("Pick a folder or repository to work in.");

      return;
    }

    if (choices.where.length > 1 && !choices.where.every(isRepository)) {
      setError("Several repositories need their URLs, not folders.");

      return;
    }

    if (team && profile === undefined) {
      setError("Team work needs a team Profile, which admins make.");

      return;
    }

    const model = choices.model === "" ? null : modelRef(choices.model);

    setInvalid(undefined);
    remember(choices, team);

    void start.run({
      ...(team && { team }),
      ...(chosen && { environment: chosen.id }),
      workspace: workspaceRequest(choices.where, choices.share, startPoint),
      ...(model && { model }),
      ...(profile && { profile: profile.id }),
      ...(choices.thinking !== "" && { thinking: choices.thinking }),
      ...(text.trim() !== "" && { firstMessage: text.trim() }),
    });
  };

  return (
    <form id="create" onSubmit={submit} className="flex flex-col">
      {children}

      <label htmlFor="first-message" className="sr-only">
        What should Pi do?
      </label>
      <textarea
        ref={message}
        id="first-message"
        rows={4}
        value={text}
        placeholder={placeholder}
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
          submit();
        }}
        className="max-h-80 min-h-24 resize-none field-sizing-content bg-transparent px-5 py-2 text-prose text-fg placeholder:text-fg-dim focus:outline-none"
      />

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
        <Picker
          label="Folder or repository"
          options={offered}
          selected={choices.where}
          multiple
          onSearch={search}
          placeholder="Search, or paste a path or repository URL"
          create={(query) => ({
            value: query,
            label: `Use ${query}`,
            detail: isRepository(query) ? "clone" : "folder",
          })}
          footer={
            <Checkbox
              label="Share the folder instead of a worktree of it"
              checked={choices.share}
              onChange={(event) => {
                choose({ share: event.target.checked });
              }}
            />
          }
          onChange={(where) => {
            choose({ where });
          }}
        >
          {choices.where.length === 0 ? (
            <span className="text-fg-dim">Pick a folder or repository</span>
          ) : (
            choices.where.map(lastSegment).join(", ")
          )}
        </Picker>

        {!sharing && (
          <Picker
            label="Start from"
            options={[{ value: "", label: "Current branch" }]}
            selected={[startPoint]}
            placeholder="Branch, tag or commit"
            create={(query) => ({ value: query, label: query })}
            onChange={([value]) => {
              setStartPoint(value ?? "");
            }}
          >
            <span className="text-fg-dim">from </span>
            {startPoint === "" ? "current branch" : startPoint}
          </Picker>
        )}

        {environments.length > 1 && (
          <Picker
            label="Environment"
            options={environments.map((environment) => ({
              value: environment.id,
              label: environment.name,
              detail: availability(environment).toLowerCase(),
            }))}
            selected={chosen ? [chosen.id] : []}
            onChange={([environment]) => {
              choose({ environment: environment ?? "", model: "" });
            }}
          >
            <span className="text-fg-dim">on </span>
            {chosen?.name}
          </Picker>
        )}

        <Picker
          label="Model"
          options={[
            { value: "", label: "Environment default" },
            ...modelChoices,
          ]}
          {...(openGroups && { openGroups })}
          selected={[choices.model]}
          placeholder="Search models"
          create={(query) =>
            modelRef(query) === undefined
              ? undefined
              : { value: query, label: `Use ${query}` }
          }
          footer={
            <Slider
              label="Reasoning"
              stops={(["", ...thinkingLevels] as const).map((level) => ({
                value: level,
                label: level === "" ? "default" : level,
              }))}
              value={choices.thinking}
              onChange={(level) => {
                choose({ thinking: level });
              }}
            />
          }
          onChange={([model]) => {
            if (model !== undefined && model !== "") {
              rememberModel(model);
            }

            choose({ model: model ?? "" });
          }}
        >
          {choices.model === "" ? "Default model" : choices.model}
          {choices.thinking !== "" && ` · ${choices.thinking}`}
        </Picker>

        {(team ? profiles.length > 0 : profiles.length > 1) && (
          <Picker
            label="Profile"
            options={profiles.map(({ id, name, isDefault }) => ({
              value: id,
              label: name,
              ...(team
                ? { group: "Team Profiles, set up by admins" }
                : isDefault && { detail: "default" }),
            }))}
            selected={profile ? [profile.id] : []}
            onChange={([id]) => {
              choose({ profile: id ?? "" });
            }}
          >
            {profile?.name}
          </Picker>
        )}

        <Button
          variant="primary"
          type="submit"
          disabled={submitting}
          className="ml-auto"
        >
          Start session
        </Button>
      </div>

      <ErrorText size="caption" className="border-t border-line px-5 py-2">
        {error}
      </ErrorText>
    </form>
  );
}
