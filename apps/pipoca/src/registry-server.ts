// Written by `bun run registries` from plugins/*. Don't edit.
import { ask } from "../../../plugins/ask/plugin";
import { server as askServer } from "../../../plugins/ask/src/server";
import { changes } from "../../../plugins/changes/plugin";
import { checklist } from "../../../plugins/checklist/plugin";
import emailPackage from "../../../plugins/email/package.json";
import * as emailServer from "../../../plugins/email/src/server";
import gitHostsPackage from "../../../plugins/git-hosts/package.json";
import * as gitHostsServer from "../../../plugins/git-hosts/src/server";
import kubernetesPackage from "../../../plugins/kubernetes/package.json";
import * as kubernetesServer from "../../../plugins/kubernetes/src/server";
import libraryPackage from "../../../plugins/library/package.json";
import * as libraryServer from "../../../plugins/library/src/server";
import localPackage from "../../../plugins/local/package.json";
import * as localServer from "../../../plugins/local/src/server";
import loginsPackage from "../../../plugins/logins/package.json";
import * as loginsServer from "../../../plugins/logins/src/server";
import metaPackage from "../../../plugins/meta/package.json";
import * as metaServer from "../../../plugins/meta/src/server";
import { models } from "../../../plugins/models/plugin";
import { server as modelsServer } from "../../../plugins/models/src/server";
import oidcPackage from "../../../plugins/oidc/package.json";
import * as oidcServer from "../../../plugins/oidc/src/server";
import projectsPackage from "../../../plugins/projects/package.json";
import * as projectsServer from "../../../plugins/projects/src/server";
import pushPackage from "../../../plugins/push/package.json";
import * as pushServer from "../../../plugins/push/src/server";
import routinesPackage from "../../../plugins/routines/package.json";
import * as routinesServer from "../../../plugins/routines/src/server";
import slackPackage from "../../../plugins/slack/package.json";
import * as slackServer from "../../../plugins/slack/src/server";
import { subagents } from "../../../plugins/subagents/plugin";
import usagePackage from "../../../plugins/usage/package.json";
import * as usageServer from "../../../plugins/usage/src/server";

export const serverRegistry = [
  { id: "ask", definition: ask, server: askServer },
  { id: "changes", definition: changes },
  { id: "checklist", definition: checklist },
  { id: "email", manifest: emailPackage.pipoca, server: emailServer },
  { id: "git-hosts", manifest: gitHostsPackage.pipoca, server: gitHostsServer },
  {
    id: "kubernetes",
    manifest: kubernetesPackage.pipoca,
    server: kubernetesServer,
  },
  { id: "library", manifest: libraryPackage.pipoca, server: libraryServer },
  { id: "local", manifest: localPackage.pipoca, server: localServer },
  { id: "logins", manifest: loginsPackage.pipoca, server: loginsServer },
  { id: "meta", manifest: metaPackage.pipoca, server: metaServer },
  { id: "models", definition: models, server: modelsServer },
  { id: "oidc", manifest: oidcPackage.pipoca, server: oidcServer },
  { id: "projects", manifest: projectsPackage.pipoca, server: projectsServer },
  { id: "push", manifest: pushPackage.pipoca, server: pushServer },
  { id: "routines", manifest: routinesPackage.pipoca, server: routinesServer },
  { id: "slack", manifest: slackPackage.pipoca, server: slackServer },
  { id: "subagents", definition: subagents },
  { id: "usage", manifest: usagePackage.pipoca, server: usageServer },
] as const;
