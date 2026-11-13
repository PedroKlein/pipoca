import {
  availability,
  type ApiInput,
  type Environment,
  profileModel,
  privateHostOf,
  recentPlaces,
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
} from "@pipoca/ui";
import { ModelField, pickerModels, RepositoryField } from "@pipoca/plugins/web";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { request } from "../data/client";
import { useAction, useMe, useQuery } from "../data/hooks";
import { branchesOf } from "../plugins";
import { href, navigate } from "../router";
import { modelRef } from "../names";
import { accessLabels } from "../session/team-access";
import {
  type Choices,
  remembered,
  remember,
  isRepository,
  lastSegment,
  workspaceRequest,
} from "./workspace";

type Steer = "team" | "view";

// The branches of the one repository picked, which Start from offers.
function useBranches(
  where: readonly string[],
  team: boolean,
): readonly string[] {
  const [only] = where;

  const url =
    where.length === 1 && only !== undefined && isRepository(only) ? only : "";

  const [listed, setListed] = useState<{
    url: string;
    branches: readonly string[];
  }>();

  useEffect(() => {
    if (url === "") {
      return;
    }

    let current = true;

    void branchesOf(url, team).then((branches) => {
      if (current) {
        setListed({ url, branches });
      }
    });

    return () => {
      current = false;
    };
  }, [url, team]);

  return listed?.url === url ? listed.branches : [];
}

const steerLabels = {
  team: "Team can steer",
  view: accessLabels.view,
} as const satisfies Record<Steer, string>;

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
  const privateHosts = useQuery("settings.privateHosts").data?.hosts ?? [];
  const profiles = useQuery("profiles.list", scope).data ?? [];

  const sessions =
    useQuery("sessions.list", {
      query: team ? { scope: "team" } : { archived: false, plugins: true },
    }).data ?? [];

  const message = useRef<HTMLTextAreaElement>(null);
  const [choices, setChoices] = useState(() => remembered(team));
  const [text, setText] = useState("");
  const [startPoint, setStartPoint] = useState("");
  const branches = useBranches(choices.where, team);
  const [invalid, setInvalid] = useState<string>();
  const [steer, setSteer] = useState<Steer>("team");

  const start = useAction(
    async (body: ApiInput<"sessions.create">["body"], access: Steer) => {
      const started = await request("sessions.create", { body });

      if (access === "view") {
        await request("sessions.update", {
          params: { id: started.id },
          body: { access: { kind: "view" } },
        });
      }

      setText("");
      setStartPoint("");
      onStarted();
      navigate(href("session", { id: started.id }));
    },
  );

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

  const choose = (change: Partial<Choices>): void => {
    setChoices((current) => ({ ...current, ...change }));
  };

  // A repository on a private host narrows Environments to those that
  // reach it (ADR 0080).
  const privateHost = choices.where
    .filter(isRepository)
    .map((repository) => privateHostOf(repository, privateHosts))
    .find((host) => host !== undefined);

  const reaches = (environment: Environment): boolean =>
    privateHost === undefined ||
    environment.reaches.some(
      (each) => each.reached && each.host === privateHost,
    );

  const chosen =
    environments.find(({ id }) => id === choices.environment) ??
    environments.find(reaches) ??
    environments[0];

  const profile =
    profiles.find(({ id }) => id === choices.profile) ??
    profiles.find(({ isDefault }) => isDefault) ??
    (team ? profiles[0] : undefined);

  const base = useQuery("settings.baseProfile").data;
  const myDefaults = useQuery("me.profileDefaults").data;

  const profileDefault = profileModel(
    profile,
    profiles,
    [team ? undefined : myDefaults, base].filter(
      (layer) => layer !== undefined,
    ),
  );

  const recent = recentPlaces(sessions, chosen?.id);

  const models = pickerModels(chosen?.models ?? [], {
    hidden: chosen?.hiddenModels ?? [],
    unavailable: chosen?.unavailableModels ?? [],
  });

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

    void start.run(
      {
        ...(team && { team }),
        ...(chosen && { environment: chosen.id }),
        workspace: workspaceRequest(choices.where, choices.share, startPoint),
        ...(model && { model }),
        ...(profile && { profile: profile.id }),
        ...(choices.thinking !== "" && { thinking: choices.thinking }),
        ...(text.trim() !== "" && { firstMessage: text.trim() }),
      },
      team ? steer : "team",
    );
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
        <RepositoryField
          label="Folder or repository"
          selected={choices.where}
          recent={recent}
          team={team}
          {...(chosen && {
            folders: {
              label: `Folders on ${chosen.name}`,
              paths: chosen.folders,
            },
          })}
          placeholder="Search, or paste a path or repository URL"
          footer={
            <Checkbox
              label="Share the folder instead of a worktree of it"
              checked={choices.share}
              onChange={(event) => {
                choose({ share: event.target.checked });
              }}
            />
          }
          hint={
            <span>
              {team
                ? "Only repositories the team's bots reach."
                : "Only repositories your logins reach."}{" "}
              <a
                className="text-fg underline"
                href={href("settings", { page: "accounts" })}
              >
                Connect another host
              </a>
            </span>
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
        </RepositoryField>

        {!sharing && (
          <Picker
            label="Start from"
            options={[
              { value: "", label: "Current branch" },
              ...branches.map((branch) => ({ value: branch, label: branch })),
            ]}
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

        {(environments.length > 1 || privateHost !== undefined) && (
          <Picker
            label="Environment"
            options={environments.map((environment) => ({
              value: environment.id,
              label: environment.name,
              detail: availability(environment).toLowerCase(),
              ...(privateHost !== undefined && {
                group: reaches(environment)
                  ? `Reaches ${privateHost}`
                  : "Can't reach it",
              }),
            }))}
            selected={chosen ? [chosen.id] : []}
            onChange={([environment]) => {
              choose({ environment: environment ?? "", model: "" });
            }}
            {...(privateHost !== undefined && {
              footer: (
                <a
                  className="text-label text-fg underline"
                  href={href("settings", { page: "environments", rest: "" })}
                >
                  Connect a machine that reaches {privateHost}
                </a>
              ),
            })}
          >
            <span className="text-fg-dim">on </span>
            {chosen?.name}
          </Picker>
        )}

        <ModelField
          label="Model"
          models={models}
          selected={choices.model}
          none="Environment default"
          create
          reasoning={{
            levels: (["", ...thinkingLevels] as const).map((level) => ({
              value: level,
              label: level === "" ? "default" : level,
            })),
            value: choices.thinking,
            onChange: (level) => {
              const thinking = (["", ...thinkingLevels] as const).find(
                (known) => known === level,
              );

              if (thinking !== undefined) {
                choose({ thinking });
              }
            },
          }}
          onPick={(model) => {
            choose({ model });
          }}
        >
          {choices.model === ""
            ? (models.find(({ value }) => value === profileDefault)?.name ??
              profileDefault ??
              "Default model")
            : (models.find(({ value }) => value === choices.model)?.name ??
              choices.model)}
          {choices.thinking !== "" && ` · ${choices.thinking}`}
        </ModelField>

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

        {team && (
          <Picker
            label="Who steers"
            options={[
              {
                value: "team",
                label: steerLabels.team,
                detail: "anyone on the team",
              },
              {
                value: "view",
                label: steerLabels.view,
                detail: "only you and admins steer",
              },
            ]}
            selected={[steer]}
            onChange={([kind]) => {
              setSteer(kind === "view" ? "view" : "team");
            }}
          >
            {steerLabels[steer]}
          </Picker>
        )}

        <Button
          variant="primary"
          type="submit"
          disabled={submitting}
          className="ml-auto"
        >
          {team ? "Start" : "Start session"}
        </Button>
      </div>

      {privateHost !== undefined &&
        chosen !== undefined &&
        !reaches(chosen) && (
          <p className="border-t border-line px-5 py-2 text-caption text-fg-dim">
            {`${chosen.name} can't reach ${privateHost}, which is private. `}
            <a
              className="text-accent underline"
              href={href("settings", { page: "environments", rest: "" })}
            >
              Connect a machine that reaches {privateHost}
            </a>
          </p>
        )}
      <ErrorText size="caption" className="border-t border-line px-5 py-2">
        {error}
      </ErrorText>
    </form>
  );
}
