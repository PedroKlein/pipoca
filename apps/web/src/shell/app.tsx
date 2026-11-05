import { Button, Icon, Mark } from "@pipoca/ui";
import type { SetupState } from "@pipoca/protocol";
import { type ReactElement, useEffect, useState } from "react";
import {
  useEnvironments,
  useHash,
  useProfiles,
  useSessions,
  useSettledNotices,
  useTeam,
} from "../hooks";
import { Drawer } from "./drawer";
import { NewSessionDialog } from "./new-session";
import { PluginBoundary } from "../plugin-boundary";
import {
  enabledPlugins,
  type NavEntry,
  pluginContext,
  pluginRoute,
  sessionHref,
} from "../plugins";
import { SessionView } from "../session-view";
import { isSettingsRoute, SettingsLayout } from "../settings/layout";
import { SetupReminders } from "../setup/reminders";
import { SetupWizard } from "../setup/wizard";
import { Sidebar } from "./sidebar";
import { isTeamRoute, TeamHub } from "../team/hub";
import { isTeamSetupRoute, TeamSetup } from "../team/setup";
import { MenuButton, PluginPage } from "./plugin-page";

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
  const sessions = useSessions(showArchived);
  const environments = useEnvironments();
  const profiles = useProfiles();
  const teamName = useTeam().name;
  useSettledNotices(sessions.value, route);

  if (drawerRoute !== route) {
    setDrawerRoute(route);
    setDrawer(false);
  }

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
      <Drawer
        open={drawer}
        onClose={() => {
          setDrawer(false);
        }}
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
      </Drawer>

      <main inert={drawer} className="flex min-w-0 flex-1 flex-col">
        {content()}
      </main>

      <NewSessionDialog
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
      />
    </div>
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
