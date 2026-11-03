import type { SetupState } from "@pipoca/protocol";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AppSignIn, pendingAppSignIn } from "./app-sign-in";
import { loadPlugins, navEntries } from "./plugins";
import { type Login, SignInPage } from "./sign-in";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

const status = await fetch("/api/auth")
  .then(
    async (response) =>
      (await response.json()) as {
        readonly user: {
          readonly name: string;
          readonly admin: boolean;
        } | null;
        readonly setup: boolean;
        readonly logins: readonly Login[];
        readonly passwordLogin: boolean;
        readonly solo: boolean;
      },
  )
  .catch(() => undefined);

const setupToken = /^#setup\/(.+)$/.exec(location.hash)?.[1];
const appChallenge = pendingAppSignIn();

if (status === undefined) {
  root.textContent = "The server can't be reached. Reload to try again.";
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

  const setup = await fetch("/api/setup")
    .then(async (response) => (await response.json()) as SetupState)
    .catch(() => ({ finished: true, dismissed: [] }));

  createRoot(root).render(
    <App
      nav={navEntries()}
      user={status.user.name}
      admin={status.user.admin}
      setup={setup}
      people={status.user.admin && !status.solo}
    />,
  );
}
