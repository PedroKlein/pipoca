import type { SetupState } from "@pipoca/protocol";
import { createRoot } from "react-dom/client";
import { request } from "./data/client";
import { seed } from "./data/hooks";
import { App } from "./shell/app";
import { AppSignIn, pendingAppSignIn } from "./setup/app-sign-in";
import { JoinPage } from "./setup/join";
import { loadPlugins } from "./plugins";
import { parse } from "./router";
import { SignInPage } from "./setup/sign-in";
import { applyTheme } from "./theme";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

applyTheme();

const status = await request("auth.status").catch(() => undefined);
const route = parse(location.hash);
const appChallenge = pendingAppSignIn();

if (status === undefined) {
  root.textContent = "The server can't be reached. Reload to try again.";
} else if (status.user === null && route.name === "join") {
  createRoot(root).render(<JoinPage token={route.params.token} />);
} else if (status.user === null) {
  createRoot(root).render(
    <SignInPage
      status={status}
      setupToken={route.name === "setup" ? route.params.token : undefined}
    />,
  );
} else if (appChallenge !== undefined) {
  createRoot(root).render(
    <AppSignIn challenge={appChallenge} user={status.user.name} />,
  );
} else {
  await loadPlugins().catch(() => undefined);

  const setup = await request("me.setup").catch((): SetupState => ({
    finished: true,
    dismissed: [],
    serverPending: false,
  }));

  seed("auth.status", status);
  seed("me.setup", setup);
  createRoot(root).render(<App />);
}
