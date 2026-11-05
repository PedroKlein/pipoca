import type { SetupState } from "@pipoca/protocol";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./shell/app";
import { AppSignIn, pendingAppSignIn } from "./setup/app-sign-in";
import { JoinPage } from "./setup/join";
import { Me } from "./me";
import { loadPlugins, navEntries, PluginShell } from "./plugins";
import { SignInPage } from "./setup/sign-in";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

const status = await api("auth.status").catch(() => undefined);

const setupToken = /^#setup\/(.+)$/.exec(location.hash)?.[1];
const joinToken = /^#join\/(.+)$/.exec(location.hash)?.[1];
const appChallenge = pendingAppSignIn();

if (status === undefined) {
  root.textContent = "The server can't be reached. Reload to try again.";
} else if (status.user === null && joinToken !== undefined) {
  createRoot(root).render(<JoinPage token={joinToken} />);
} else if (status.user === null) {
  createRoot(root).render(
    <SignInPage
      setup={status.setup}
      setupToken={setupToken}
      logins={status.logins}
      passwordLogin={status.passwordLogin}
      solo={status.solo}
    />,
  );
} else if (appChallenge !== undefined) {
  createRoot(root).render(
    <AppSignIn challenge={appChallenge} user={status.user.name} />,
  );
} else {
  await loadPlugins().catch(() => undefined);

  const setup = await api("me.setup").catch((): SetupState => ({
    finished: true,
    dismissed: [],
  }));

  createRoot(root).render(
    <Me
      value={{
        id: status.user.id,
        admin: status.user.admin,
        team: !status.solo,
      }}
    >
      <PluginShell
        viewer={{
          person: {
            id: status.user.id,
            name: status.user.name,
            admin: status.user.admin,
          },
          admin: status.user.admin,
          team: !status.solo,
        }}
      >
        <App
          nav={navEntries()}
          user={status.user.name}
          admin={status.user.admin}
          setup={setup}
          people={status.user.admin && !status.solo}
          team={!status.solo}
        />
      </PluginShell>
    </Me>,
  );
}
