import { Button, Icon, Mark } from "@pipoca/ui";
import {
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMe, useQuery } from "../data/hooks";
import { useSettledNotices } from "./settled-notices";
import { Drawer } from "./drawer";
import { NewSessionDialog } from "./new-session";
import { PluginBoundary } from "../plugin-boundary";
import { fillsOf, navEntries, PluginShell, sessionHref } from "../plugins";
import { href, navigate, type Route, useRoute } from "../router";
import { SessionView } from "../session/session-view";
import { SettingsLayout } from "../settings/layout";
import { SetupReminders } from "../setup/reminders";
import { SetupWizard } from "../setup/wizard";
import { Sidebar } from "./sidebar";
import { TeamHub } from "../team/hub";
import { MenuButton, PluginPage } from "./plugin-page";

export function App(): ReactElement {
  const { user, team } = useMe();

  const viewer = useMemo(
    () => ({
      person: { id: user.id, name: user.name, admin: user.admin },
      team,
    }),
    [user.id, user.name, user.admin, team],
  );

  return (
    <PluginShell viewer={viewer}>
      <Screens />
    </PluginShell>
  );
}

function Screens(): ReactElement {
  const route = useRoute();
  const { team } = useMe();
  const setup = useQuery("me.setup").data;

  // A finished Session is told about from either workspace.
  const own =
    useQuery("sessions.list", { query: { archived: false, plugins: true } })
      .data ?? [];

  useSettledNotices(
    own,
    route.name === "session" || route.name === "teamSession"
      ? route.params.id
      : "",
  );

  // The wizard stays until it is left, while finishing the server's setup
  // and then the person's changes what the server says is left to do.
  const [settingUp, setSettingUp] = useState(
    setup !== undefined && (!setup.finished || setup.serverPending),
  );

  if (settingUp || route.name === "getStarted") {
    return (
      <SetupWizard
        key={route.name === "getStarted" ? route.params.step : ""}
        start={route.name === "getStarted" ? route.params.step : undefined}
        onLeave={() => {
          setSettingUp(false);
        }}
      />
    );
  }

  if (route.name === "settings") {
    return (
      <Area>
        <SettingsLayout page={route.params.page} rest={route.params.rest} />
      </Area>
    );
  }

  if (route.name.startsWith("team") && team) {
    return (
      <Area>
        <TeamHub route={route} />
      </Area>
    );
  }

  return <Work route={route} />;
}

function Area({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div className="flex h-dvh overflow-hidden bg-bg font-sans text-ui text-fg">
      {children}
    </div>
  );
}

// A person's own work: the sidebar beside home, a Session or a plugin's page.
function Work({ route }: { readonly route: Route }): ReactElement {
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(route);

  const sessions =
    useQuery("sessions.list", {
      query: { archived: showArchived, plugins: true },
    }).data ?? [];

  const opened = route.name === "session" ? route.params.id : "";

  if (drawerRoute !== route) {
    setDrawerRoute(route);
    setDrawer(false);
  }

  const listed = sessions.find(({ id }) => id === opened);
  const shownAt = listed ? sessionHref(listed) : undefined;

  const moved =
    shownAt === href("session", { id: opened }) ? undefined : shownAt;

  // A Session a plugin shows opens in the plugin's page (ADR 0028).
  useEffect(() => {
    if (moved !== undefined) {
      navigate(moved, { replace: true });
    }
  }, [moved]);

  const openDrawer = (): void => {
    setDrawer(true);
  };

  const newSession = (): void => {
    setCreating(true);
  };

  const content = (): ReactElement => {
    if (route.name === "plugin") {
      return (
        <PluginPage
          key={route.params.name}
          name={route.params.name}
          path={route.params.path}
          onMenu={openDrawer}
        />
      );
    }

    if (route.name === "session" && moved === undefined) {
      return (
        <SessionView key={opened} sessionId={opened} onMenu={openDrawer} />
      );
    }

    if (route.name === "session") {
      return <div className="flex-1" />;
    }

    return <Home onMenu={openDrawer} onNewSession={newSession} />;
  };

  return (
    <Area>
      <Drawer
        open={drawer}
        onClose={() => {
          setDrawer(false);
        }}
      >
        <Sidebar
          nav={navEntries()}
          route={route}
          sessions={sessions}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          onNewSession={newSession}
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
    </Area>
  );
}

function Home({
  onMenu,
  onNewSession,
}: {
  readonly onMenu: () => void;
  readonly onNewSession: () => void;
}): ReactElement {
  const home = fillsOf("home")[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="p-2 md:hidden">
        <MenuButton onMenu={onMenu} />
      </div>
      <SetupReminders />
      {home ? (
        <PluginBoundary name={home.plugin}>
          <home.Component onNewSession={onNewSession} />
        </PluginBoundary>
      ) : (
        <Empty onNewSession={onNewSession} />
      )}
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
