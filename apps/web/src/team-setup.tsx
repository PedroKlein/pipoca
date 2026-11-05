import type { SetupScreen } from "@pipoca/plugins/web";
import { AreaLayout, Badge, Button, Field, fieldClass, PageTitle, Row, Rows, Switch } from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  type SubmitEvent,
  useState,
} from "react";
import { send } from "./api";
import { EnvironmentsPage } from "./environments";
import { usePlugins, useTeamEnvironments, useTeamProfiles } from "./hooks";
import { settingsPageClass } from "./page-class";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";
import { ProfilesPage } from "./profiles";
import { ServerPageView, serverPages, SharedNote } from "./settings-layout";

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly count?: number;
}

interface Screen extends SetupScreen {
  readonly path: string;
  readonly plugin: string;
}

export function isTeamSetupRoute(route: string): boolean {
  return /^team\/setup(\/|$)/.test(route);
}

function screens(): readonly Screen[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub?.setup ?? {}).map(([key, screen]) => ({
      ...screen,
      path: `team/setup/plugin/${name}/${key}`,
      plugin: name,
    })),
  );
}

// What team work runs on and its rules, which only admins change, and the
// server's own pages that personal Settings shows too (ADRs 0064 and 0067).
export function TeamSetup({
  route,
  user,
  people,
  teamName,
}: {
  readonly route: string;
  readonly user: string;
  readonly people: boolean;
  readonly teamName: string | null;
}): ReactElement {
  const profiles = useTeamProfiles();
  const environments = useTeamEnvironments();
  const plugins = screens();
  const server = serverPages(people);
  const [, , section = "profiles", ...rest] = route.split("/");
  const selected = rest.join("/");

  const groups: readonly (readonly [string, readonly Entry[]])[] = [
    [
      "What team work runs on",
      [
        {
          path: "team/setup/profiles",
          label: "Profiles",
          count: profiles.value.length,
        },
        {
          path: "team/setup/environments",
          label: "Environments",
          count: environments.value.length,
        },
        ...plugins.filter(({ group }) => group === "runs-on"),
      ],
    ],
    [
      "Rules",
      [
        { path: "team/setup/name", label: "Name" },
        { path: "team/setup/plugins", label: "Plugins in team work" },
        ...plugins.filter(({ group }) => group === "rules"),
      ],
    ],
    [
      "Shared with personal work",
      server.map(({ key, label }) => ({
        path: `team/setup/server/${key}`,
        label,
      })),
    ],
  ];

  const content = (): ReactNode => {
    const shared =
      section === "server"
        ? server.find(({ key }) => key === rest[0])
        : undefined;

    if (shared !== undefined) {
      return (
        <>
          <SharedNote>
            Server-wide, for personal and team work alike. It&apos;s the same
            page as in{" "}
            <a href={`#${shared.path}`} className="text-fg underline">
              Settings
            </a>
            , so a change shows in both.
          </SharedNote>
          <ServerPageView
            page={shared}
            route={route}
            base={`team/setup/server/${shared.key}`}
            user={user}
          />
        </>
      );
    }

    if (section === "environments") {
      return (
        <EnvironmentsPage
          environments={environments.value}
          team
          selected={selected}
          onChange={environments.reload}
        />
      );
    }

    if (section === "plugins") {
      return <TeamPlugins />;
    }

    if (section === "name") {
      return <TeamNaming name={teamName} />;
    }

    const screen = plugins.find(({ path }) => path === route);

    if (screen !== undefined) {
      return (
        <div className={settingsPageClass}>
          <PluginBoundary name={screen.plugin}>
            <screen.Page context={pluginContext(screen.plugin)} />
          </PluginBoundary>
        </div>
      );
    }

    return (
      <ProfilesPage
        profiles={profiles.value}
        admin
        team
        selected={section === "profiles" ? selected : ""}
        onChange={profiles.reload}
      />
    );
  };

  const current = (path: string): boolean =>
    route === path ||
    route.startsWith(`${path}/`) ||
    (path === "team/setup/profiles" && route === "team/setup");

  return (
    <AreaLayout
      label="Team setup"
      back={{ href: "#team", label: "Team home" }}
      heading="Team setup"
      groups={groups.map(([label, entries]) => ({
        label,
        items: entries.map(({ path, label: name, count }) => ({
          href: `#${path}`,
          label: name,
          current: current(path),
          ...(count !== undefined && { count }),
        })),
      }))}
    >
      {content()}
    </AreaLayout>
  );
}

function TeamNaming({ name }: { readonly name: string | null }): ReactElement {
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const shown = draft ?? name ?? "";

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);

    send("/api/team", "PUT", { name: shown }).then(
      () => {
        setError(undefined);
        setSaved(true);
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className={settingsPageClass}>
      <PageTitle description="Shown on the team hub and in everyone's sidebar.">
        Name
      </PageTitle>
      <form onSubmit={save} className="flex max-w-md flex-col gap-4">
        <Field label="Team name" hint="Left empty, it shows as Team.">
          <input
            value={shown}
            maxLength={60}
            placeholder="Team"
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
            }}
            className={fieldClass}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Save
          </Button>
          {saved && (
            <span role="status" className="text-label text-fg-dim">
              Saved
            </span>
          )}
        </div>
        {error !== undefined && (
          <p role="alert" className="text-label text-failed">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

// A plugin loads in team Sessions only if it says it works in team work and
// admins leave it on there (ADR 0067).
function TeamPlugins(): ReactElement {
  const { value: plugins, reload } = usePlugins();
  const [error, setError] = useState<string>();

  const turn = (id: string, on: boolean): void => {
    send(`/api/plugins/${encodeURIComponent(id)}`, "PATCH", {
      teamWork: on,
    }).then(
      () => {
        setError(undefined);
        reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <div className={settingsPageClass}>
      <PageTitle description="A plugin loads in team Sessions only if it says it works in team work and you leave it on. Built-in ones start on, installed ones start off. New team Sessions pick up a change.">
        Plugins in team work
      </PageTitle>
      {error !== undefined && (
        <p role="alert" className="mb-4 text-label text-failed">
          {error}
        </p>
      )}
      <Rows label="Plugins in team work">
        {plugins
          .filter(({ state }) => state === "on")
          .map(({ id, title, description, works, teamWork }) => {
            const supports = works?.includes("team") === true;

            return (
              <Row key={id} title={title} description={description}>
                <Badge state={supports ? "done" : "offline"}>
                  {supports ? "Works in team work" : "Personal only"}
                </Badge>
                <Switch
                  label={`${title} in team work`}
                  labelHidden
                  checked={teamWork}
                  disabled={!supports}
                  onChange={(on) => {
                    turn(id, on);
                  }}
                />
              </Row>
            );
          })}
      </Rows>
    </div>
  );
}
