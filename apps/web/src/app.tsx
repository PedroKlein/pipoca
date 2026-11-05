import { Button, cn, Icon } from "@pipoca/ui";
import type { SetupState } from "@pipoca/protocol";
import { type ReactElement, useEffect, useRef, useState } from "react";
import {
  useEnvironments,
  useHash,
  useProfiles,
  useSessions,
  useSettledNotices,
  useTeam,
} from "./hooks";
import { ShellMenu } from "./embedded-session";
import { NewSessionDialog } from "./new-session";
import { PluginBoundary } from "./plugin-boundary";
import {
  enabledPlugins,
  type NavEntry,
  pageFills,
  pluginContext,
  pluginRoute,
  sessionHref,
} from "./plugins";
import { SessionView } from "./session-view";
import { isSettingsRoute, SettingsLayout } from "./settings-layout";
import { Mark } from "./mark";
import { SetupReminders, SetupWizard } from "./setup";
import { Sidebar } from "./sidebar";
import { isTeamRoute, TeamHub } from "./team-hub";
import { isTeamSetupRoute, TeamSetup } from "./team-setup";

export function App({
  nav,
  user,
  admin,
  people,
  team,
  setup: initialSetup,
}: {
  readonly nav: readonly NavEntry[];
  readonly user: string;
  readonly admin: boolean;
  // An admin of a server several people use sees the People page.
  readonly people: boolean;
  // A server several people use has a team, with its own hub (ADR 0064).
  readonly team: boolean;
  readonly setup: SetupState;
}): ReactElement {
  const route = useHash();
  const [setup, setSetup] = useState(initialSetup);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(route);
  const aside = useRef<HTMLElement>(null);
  const sessions = useSessions(showArchived);
  const environments = useEnvironments();
  const profiles = useProfiles();
  const teamName = useTeam().name;
  useSettledNotices(sessions.value, route);

  if (drawerRoute !== route) {
    setDrawerRoute(route);
    setDrawer(false);
  }

  useEffect(() => {
    if (!drawer) {
      return;
    }

    const opener = document.activeElement;

    aside.current
      ?.querySelector<HTMLElement>("a[href], button:not(:disabled), input")
      ?.focus();

    const wide = matchMedia("(width >= 48rem)");

    const close = (): void => {
      setDrawer(false);
    };

    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };

    wide.addEventListener("change", close);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      wide.removeEventListener("change", close);
      document.removeEventListener("keydown", closeOnEscape);

      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, [drawer]);

  const page = pluginRoute(route);
  const listed = sessions.value.find(({ id }) => id === route);
  const moved = listed ? sessionHref(listed) : undefined;

  // Old links and notices name a Session its plugin now shows (ADR 0028).
  useEffect(() => {
    if (moved !== undefined && moved !== `#${route}`) {
      location.replace(moved);
    }
  }, [moved, route]);

  const openDrawer = (): void => {
    setDrawer(true);
  };

  const content = (): ReactElement => {
    if (page !== undefined) {
      return (
        <PluginPage
          key={page.name}
          name={page.name}
          path={page.path}
          onMenu={openDrawer}
        />
      );
    }

    if (moved !== undefined && moved !== `#${route}`) {
      return <div className="flex-1" />;
    }

    if (route === "") {
      const home = enabledPlugins().find(({ Home }) => Home !== undefined);

      const newSession = (): void => {
        setCreating(true);
      };

      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="p-2 md:hidden">
            <MenuButton onMenu={openDrawer} />
          </div>
          <SetupReminders
            setup={setup}
            onDismiss={(step) => {
              setSetup({ ...setup, dismissed: [...setup.dismissed, step] });
            }}
          />
          {home?.Home ? (
            <PluginBoundary name={home.name}>
              <home.Home
                context={pluginContext(home.name)}
                onNewSession={newSession}
              />
            </PluginBoundary>
          ) : (
            <Empty onNewSession={newSession} />
          )}
        </div>
      );
    }

    return (
      <SessionView
        key={route}
        sessionId={route}
        environments={environments.value}
        onSessionChange={sessions.reload}
        onMenu={openDrawer}
      />
    );
  };

  const reminded = /^get-started\/(.+)$/.exec(route)?.[1];

  if (!setup.finished || reminded !== undefined) {
    return (
      <SetupWizard
        key={reminded}
        user={user}
        admin={admin}
        start={reminded}
        onFinish={() => {
          setSetup({ ...setup, finished: true });
        }}
      />
    );
  }

  // Settings is a page of its own, with its own menu in place of the
  // sidebar (ADR 0063).
  if (page === undefined && isSettingsRoute(route)) {
    return (
      <div className="flex h-dvh overflow-hidden bg-bg font-sans text-ui text-fg">
        <SettingsLayout
          route={route}
          user={user}
          admin={admin}
          people={people}
          team={team}
          environments={environments.value}
          profiles={profiles.value}
          onEnvironmentsChange={environments.reload}
          onProfilesChange={profiles.reload}
        />
      </div>
    );
  }

  if (page === undefined && team && isTeamRoute(route)) {
    return (
      <div className="flex h-dvh overflow-hidden bg-bg font-sans text-ui text-fg">
        {admin && isTeamSetupRoute(route) ? (
          <TeamSetup
            route={route}
            user={user}
            people={people}
            teamName={teamName}
          />
        ) : (
          <TeamHub route={route} admin={admin} name={teamName} />
        )}
      </div>
    );
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-bg font-sans text-ui text-fg">
      <div
        aria-hidden="true"
        onClick={() => {
          setDrawer(false);
        }}
        className={cn(
          "fixed inset-0 z-10 bg-scrim md:hidden",
          !drawer && "hidden",
        )}
      />
      <aside
        ref={aside}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a")) {
            setDrawer(false);
          }
        }}
        className={cn(
          "z-20 w-sidebar shrink-0 border-r border-line max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-[min(320px,85vw)] max-md:shadow-pop",
          // Showing it at once lets focus move in; hiding it after the slide keeps the slide visible.
          drawer
            ? "max-md:motion-safe:transition-[translate]"
            : "max-md:invisible max-md:-translate-x-full max-md:motion-safe:transition-[translate,visibility]",
        )}
      >
        <Sidebar
          nav={nav}
          route={route}
          sessions={sessions.value}
          environments={environments.value}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          user={user}
          team={team ? (teamName ?? "Team") : undefined}
          onNewSession={() => {
            setCreating(true);
          }}
        />
      </aside>

      <main inert={drawer} className="flex min-w-0 flex-1 flex-col">
        {content()}
      </main>

      <NewSessionDialog
        open={creating}
        environments={environments.value}
        profiles={profiles.value}
        sessions={sessions.value}
        onClose={() => {
          setCreating(false);
        }}
      />
    </div>
  );
}

function MenuButton({ onMenu }: { readonly onMenu: () => void }): ReactElement {
  return (
    <Button
      variant="ghost"
      iconOnly
      aria-label="Open sessions"
      onClick={onMenu}
      className="md:hidden"
    >
      <Icon name="menu" />
    </Button>
  );
}

function Empty({
  onNewSession,
}: {
  readonly onNewSession: () => void;
}): ReactElement {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 p-8 text-center">
      <Mark className="size-16" />
      <h1 className="font-serif text-hero font-light text-fg-strong">pipoca</h1>
      <p className="text-fg-dim">
        Pick a session, or start a new one on one of your machines.
      </p>
      <Button variant="primary" onClick={onNewSession}>
        <Icon name="plus" />
        Start a session
      </Button>
    </div>
  );
}

function PluginPage({
  name,
  path,
  onMenu,
}: {
  readonly name: string;
  readonly path: string;
  readonly onMenu: () => void;
}): ReactElement {
  const Page = enabledPlugins().find((plugin) => plugin.name === name)?.nav
    ?.Page;

  const body = Page ? (
    <PluginBoundary key={name} name={name}>
      <Page context={pluginContext(name)} path={path} />
    </PluginBoundary>
  ) : (
    <p className="text-fg-dim">This page isn&apos;t available.</p>
  );

  if (pageFills(name, path)) {
    return (
      <ShellMenu value={onMenu}>
        <div
          id="plugin-page"
          data-plugin={name}
          className="flex min-h-0 min-w-0 flex-1"
        >
          {body}
        </div>
      </ShellMenu>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <div
        id="plugin-page"
        data-plugin={name}
        className="mx-auto flex w-full max-w-form flex-col px-4 py-10 md:px-10"
      >
        {body}
      </div>
    </div>
  );
}
