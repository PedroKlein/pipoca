// Written by `bun run registries` from plugins/*. Don't edit.
import { ask } from "../../../plugins/ask/plugin";
import { server as askServer } from "../../../plugins/ask/src/server";
import { changes } from "../../../plugins/changes/plugin";
import { checklist } from "../../../plugins/checklist/plugin";
import { email } from "../../../plugins/email/plugin";
import { server as emailServer } from "../../../plugins/email/src/server";
import { gitHosts } from "../../../plugins/git-hosts/plugin";
import { server as gitHostsServer } from "../../../plugins/git-hosts/src/server";
import { kubernetes } from "../../../plugins/kubernetes/plugin";
import { server as kubernetesServer } from "../../../plugins/kubernetes/src/server";
import { local } from "../../../plugins/local/plugin";
import { server as localServer } from "../../../plugins/local/src/server";
import { logins } from "../../../plugins/logins/plugin";
import { server as loginsServer } from "../../../plugins/logins/src/server";
import { models } from "../../../plugins/models/plugin";
import { server as modelsServer } from "../../../plugins/models/src/server";
import { oidc } from "../../../plugins/oidc/plugin";
import { server as oidcServer } from "../../../plugins/oidc/src/server";
import { projects } from "../../../plugins/projects/plugin";
import { server as projectsServer } from "../../../plugins/projects/src/server";
import { push } from "../../../plugins/push/plugin";
import { server as pushServer } from "../../../plugins/push/src/server";
import { routines } from "../../../plugins/routines/plugin";
import { server as routinesServer } from "../../../plugins/routines/src/server";
import { slack } from "../../../plugins/slack/plugin";
import { server as slackServer } from "../../../plugins/slack/src/server";
import { subagents } from "../../../plugins/subagents/plugin";
import { usage } from "../../../plugins/usage/plugin";
import { server as usageServer } from "../../../plugins/usage/src/server";

export const serverRegistry = [
  { id: "ask", definition: ask, server: askServer },
  { id: "changes", definition: changes },
  { id: "checklist", definition: checklist },
  { id: "email", definition: email, server: emailServer },
  { id: "git-hosts", definition: gitHosts, server: gitHostsServer },
  { id: "kubernetes", definition: kubernetes, server: kubernetesServer },
  { id: "local", definition: local, server: localServer },
  { id: "logins", definition: logins, server: loginsServer },
  { id: "models", definition: models, server: modelsServer },
  { id: "oidc", definition: oidc, server: oidcServer },
  { id: "projects", definition: projects, server: projectsServer },
  { id: "push", definition: push, server: pushServer },
  { id: "routines", definition: routines, server: routinesServer },
  { id: "slack", definition: slack, server: slackServer },
  { id: "subagents", definition: subagents },
  { id: "usage", definition: usage, server: usageServer },
] as const;
