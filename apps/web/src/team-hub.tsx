import { useNow } from "@pipoca/plugins/web";
import type { HubPanel, HubScreen } from "@pipoca/plugins/web";
import type { HubPage, Session } from "@pipoca/protocol";
import { AreaLayout, Badge, Button, fieldClass, Icon, type IconName, PageTitle, plural, Row, Rows, Section, Select } from "@pipoca/ui";
import { type ReactElement, type ReactNode, useState } from "react";
import { send } from "./api";
import { useHubLayout, useTeamEnvironments, useTeammates, useTeamProfiles, useTeamSessions } from "./hooks";
import { NewSessionDialog } from "./new-session";
import { ago, sessionBadge, shortName, teamSessionHref } from "./names";
import { settingsPageClass } from "./page-class";
import { PluginBoundary } from "./plugin-boundary";
import { SessionView } from "./session-view";
import { enabledPlugins, pluginContext } from "./plugins";

interface Entry {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
}

interface Placed extends HubPanel {
  readonly id: string;
  readonly plugin: string;
}

interface Screen extends HubScreen {
  readonly path: string;
  readonly plugin: string;
}

const busy = new Set<Session["status"]>(["queued", "starting", "running"]);

export function isTeamRoute(route: string): boolean {
  return /^team(\/|$)/.test(route);
}

function panels(): readonly Placed[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub?.panels ?? {}).map(([key, panel]) => ({
      ...panel,
      id: `${name}/${key}`,
      plugin: name,
    })),
  );
}

function screens(): readonly Screen[] {
  return enabledPlugins().flatMap(({ name, hub }) =>
    Object.entries(hub?.pages ?? {}).map(([key, screen]) => ({
      ...screen,
      path: `team/plugin/${name}/${key}`,
      plugin: name,
    })),
  );
}

// Until an admin lays it out, Home shows every panel.
function pagesOf(laid: readonly HubPage[] | null): readonly HubPage[] {
  return (
    laid ?? [
      { id: "home", title: "Home", panels: panels().map(({ id }) => id) },
    ]
  );
}

function pathOf({ id }: HubPage): string {
  return id === "home" ? "team" : `team/page/${id}`;
}

function newPageId(title: string, pages: readonly HubPage[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "page";

  let id = base;

  for (let n = 2; pages.some((page) => page.id === id); n++) {
    id = `${base}-${String(n)}`;
  }

  return id;
}

// The team's own area, apart from a person's work, with its own menu. Its
// pages are layouts of the panels plugins give it (ADRs 0065 and 0067).
export function TeamHub({
  route,
  admin,
  name,
}: {
  readonly route: string;
  readonly admin: boolean;
  readonly name: string | null;
}): ReactElement {
  const people = useTeammates();
  const sessions = useTeamSessions();
  const environments = useTeamEnvironments();
  const profiles = useTeamProfiles();
  const layout = useHubLayout();
  const [starting, setStarting] = useState(false);
  const pages = pagesOf(layout.pages);
  const [error, setError] = useState<string>();

  const lay = (next: readonly HubPage[]): void => {
    send("/api/hub", "PUT", { pages: next }).then(
      () => {
        setError(undefined);
        layout.reload();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  const entries: readonly Entry[] = [
    ...pages.map((page) => ({
      path: pathOf(page),
      label: page.title,
      icon: page.id === "home" ? ("home" as const) : ("panel-right" as const),
    })),
    { path: "team/sessions", label: "Sessions", icon: "menu" },
    ...screens().map(({ path, label }) => ({
      path,
      label,
      icon: "panel-right" as const,
    })),
  ];

  const open = pages.find((page) => pathOf(page) === route);
  const screen = screens().find(({ path }) => path === route);

  const opened = /^team\/sessions\/(.+)$/.exec(route)?.[1];

  const content = (): ReactNode => {
    if (opened !== undefined) {
      return (
        <SessionView
          key={opened}
          sessionId={opened}
          environments={environments.value}
          onSessionChange={sessions.reload}
        />
      );
    }

    if (route === "team/sessions") {
      return <TeamSessions sessions={sessions.value} />;
    }

    if (screen !== undefined) {
      return (
        <div className={settingsPageClass}>
          <PluginBoundary name={screen.plugin}>
            <screen.Page context={pluginContext(screen.plugin)} />
          </PluginBoundary>
        </div>
      );
    }

    const page = open ?? pages[0];

    if (page === undefined) {
      return null;
    }

    return (
      <LayoutPage
        key={page.id}
        page={page}
        sessions={sessions.value}
        admin={admin}
        error={error}
        onStart={() => {
          setStarting(true);
        }}
        onChange={(changed) => {
          lay(pages.map((each) => (each.id === changed.id ? changed : each)));
        }}
        onRemove={() => {
          lay(pages.filter((each) => each.id !== page.id));
          location.assign("#team");
        }}
      />
    );
  };

  return (
    <AreaLayout
      label="Team"
      back={{ href: "#", label: "My work" }}
      heading={name ?? "Team"}
      detail={
        people.loaded ? plural(people.value.length, "person", "people") : undefined
      }
      groups={[
        {
          items: [
            ...entries.map(({ path, label, icon }) => ({
              href: `#${path}`,
              label,
              icon,
              current:
                route === path ||
                (route === "team/" && path === "team") ||
                (opened !== undefined && path === "team/sessions"),
            })),
            ...(admin
              ? [
                  {
                    href: "#team/setup",
                    label: "Team setup",
                    icon: "settings" as const,
                  },
                ]
              : []),
          ],
        },
      ]}
      footer={
        admin && (
          <AddPage
            onAdd={(title) => {
              const page = { id: newPageId(title, pages), title, panels: [] };

              lay([...pages, page]);
              location.assign(`#${pathOf(page)}`);
            }}
          />
        )
      }
      fill={opened !== undefined}
    >
      {content()}
      <NewSessionDialog
        open={starting}
        team
        environments={environments.value}
        profiles={profiles.value}
        sessions={sessions.value}
        onClose={() => {
          setStarting(false);
        }}
      />
    </AreaLayout>
  );
}

function AddPage({
  onAdd,
}: {
  readonly onAdd: (title: string) => void;
}): ReactElement {
  const [title, setTitle] = useState<string>();

  if (title === undefined) {
    return (
      <button
        type="button"
        onClick={() => {
          setTitle("");
        }}
        className="mt-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-label text-fg-dim hover:bg-hover"
      >
        <Icon name="plus" />
        Add page
      </button>
    );
  }

  return (
    <form
      className="mt-1 px-1"
      onSubmit={(event) => {
        event.preventDefault();

        if (title.trim() !== "") {
          onAdd(title.trim());
        }

        setTitle(undefined);
      }}
    >
      <input
        aria-label="New page title"
        placeholder="Page title"
        autoFocus
        maxLength={60}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setTitle(undefined);
          }
        }}
        className={fieldClass}
      />
    </form>
  );
}

function LayoutPage({
  page,
  sessions,
  admin,
  error,
  onStart,
  onChange,
  onRemove,
}: {
  readonly page: HubPage;
  readonly sessions: readonly Session[];
  readonly admin: boolean;
  readonly error: string | undefined;
  readonly onStart: () => void;
  readonly onChange: (page: HubPage) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const available = panels();
  const home = page.id === "home";

  const shown = page.panels.flatMap((id) => {
    const panel = available.find((each) => each.id === id);

    return panel === undefined ? [] : [panel];
  });

  const missing = available.filter(({ id }) => !page.panels.includes(id));

  const move = (index: number, by: number): void => {
    const next = [...page.panels];
    const [moved] = next.splice(index, 1);

    if (moved !== undefined) {
      next.splice(index + by, 0, moved);
      onChange({ ...page, panels: next });
    }
  };

  return (
    <div className={settingsPageClass}>
      <PageTitle
        description={
          home
            ? "What the team is working on now. Team work runs on the team's Profiles, Environments and keys."
            : undefined
        }
        actions={
          <>
            {admin && (
              <Button
                aria-pressed={editing}
                onClick={() => {
                  setEditing(!editing);
                }}
              >
                {editing ? "Done" : "Edit layout"}
              </Button>
            )}
            {home && (
              <Button variant="primary" onClick={onStart}>
                <Icon name="plus" />
                Start team work
              </Button>
            )}
          </>
        }
      >
        {home ? "Team home" : page.title}
      </PageTitle>
      {error !== undefined && (
        <p role="alert" className="mb-4 text-label text-failed">
          {error}
        </p>
      )}
      {editing && (
        <Section
          title="Panels on this page"
          actions={
            home ? undefined : (
              <Button variant="danger" onClick={onRemove}>
                Remove page
              </Button>
            )
          }
        >
          <Rows label="Panels on this page">
            {page.panels.map((id, index) => (
              <Row
                key={id}
                title={available.find((each) => each.id === id)?.title ?? id}
                description={id}
              >
                <Button
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => {
                    move(index, -1);
                  }}
                >
                  Up
                </Button>
                <Button
                  variant="ghost"
                  disabled={index === page.panels.length - 1}
                  onClick={() => {
                    move(index, 1);
                  }}
                >
                  Down
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    onChange({
                      ...page,
                      panels: page.panels.filter((each) => each !== id),
                    });
                  }}
                >
                  Remove
                </Button>
              </Row>
            ))}
          </Rows>
          {missing.length > 0 && (
            <Select
              aria-label="Add a panel"
              value=""
              onChange={(event) => {
                onChange({
                  ...page,
                  panels: [...page.panels, event.target.value],
                });
              }}
            >
              <option value="" disabled>
                Add a panel
              </option>
              {missing.map(({ id, title }) => (
                <option key={id} value={id}>
                  {title}
                </option>
              ))}
            </Select>
          )}
        </Section>
      )}
      {home && (
        <>
          <Section
            title="Needs someone"
            description="Any of you can pick these up"
          >
            <SessionRows
              sessions={sessions.filter(({ waiting }) => waiting)}
              empty="Nothing is waiting on the team."
            />
          </Section>
          <Section title="Running now">
            <SessionRows
              sessions={sessions.filter(
                ({ status, waiting }) => !waiting && busy.has(status),
              )}
              empty="No team work is running."
            />
          </Section>
        </>
      )}
      {shown.length > 0 && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {shown.map(({ id, title, plugin, Panel }) => (
            <section
              key={id}
              aria-label={title}
              className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-line bg-elevated p-4 shadow-xs"
            >
              <h2 className="text-prose font-semibold text-fg-strong">
                {title}
              </h2>
              <PluginBoundary name={plugin}>
                <Panel context={pluginContext(plugin)} />
              </PluginBoundary>
            </section>
          ))}
        </div>
      )}
      {!home && shown.length === 0 && !editing && (
        <p className="text-label text-fg-dim">
          {admin
            ? "No panels here yet. Edit the layout to add some."
            : "No panels here yet."}
        </p>
      )}
    </div>
  );
}

function TeamSessions({
  sessions,
}: {
  readonly sessions: readonly Session[];
}): ReactElement {
  return (
    <div className={settingsPageClass}>
      <PageTitle description="Every Session the team has, newest first. Anyone on the team can open one.">
        Sessions
      </PageTitle>
      <SessionRows sessions={sessions} empty="The team has no Sessions yet." />
    </div>
  );
}

function SessionRows({
  sessions,
  empty,
}: {
  readonly sessions: readonly Session[];
  readonly empty: ReactNode;
}): ReactElement {
  const now = useNow();

  if (sessions.length === 0) {
    return <p className="text-label text-fg-dim">{empty}</p>;
  }

  return (
    <Rows>
      {sessions.map((session) => {
        const badge = sessionBadge(session);

        return (
          <Row
            key={session.id}
            title={
              <a
                href={teamSessionHref(session.id)}
                className="hover:underline focus-visible:underline"
              >
                {session.title ?? shortName(session.workspace)}
              </a>
            }
            description={`${shortName(session.workspace)} · ${ago(session.createdAt, now)}`}
          >
            {badge && <Badge state={badge.state}>{badge.label}</Badge>}
          </Row>
        );
      })}
    </Rows>
  );
}
