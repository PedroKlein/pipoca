// Written by `bun run registries` from plugins/*/package.json. Don't edit.
import * as askWeb from "../../../plugins/ask/web/index";
import * as changesWeb from "../../../plugins/changes/web/index";
import * as checklistWeb from "../../../plugins/checklist/web/index";
import * as emailWeb from "../../../plugins/email/web/index";
import * as gitHostsWeb from "../../../plugins/git-hosts/web/index";
import * as kubernetesWeb from "../../../plugins/kubernetes/web/index";
import * as libraryWeb from "../../../plugins/library/web/index";
import * as localWeb from "../../../plugins/local/web/index";
import * as loginsWeb from "../../../plugins/logins/web/index";
import * as metaWeb from "../../../plugins/meta/web/index";
import * as modelsWeb from "../../../plugins/models/web/index";
import * as oidcWeb from "../../../plugins/oidc/web/index";
import * as projectsWeb from "../../../plugins/projects/web/index";
import * as pushWeb from "../../../plugins/push/web/index";
import * as routinesWeb from "../../../plugins/routines/web/index";
import * as slackWeb from "../../../plugins/slack/web/index";
import * as subagentsWeb from "../../../plugins/subagents/web/index";
import * as usageWeb from "../../../plugins/usage/web/index";

export const webRegistry = [
  { id: "ask", plugin: askWeb },
  { id: "changes", plugin: changesWeb },
  { id: "checklist", part: checklistWeb },
  { id: "email", plugin: emailWeb },
  { id: "git-hosts", plugin: gitHostsWeb },
  { id: "kubernetes", plugin: kubernetesWeb },
  { id: "library", plugin: libraryWeb },
  { id: "local", plugin: localWeb },
  { id: "logins", plugin: loginsWeb },
  { id: "meta", plugin: metaWeb },
  { id: "models", plugin: modelsWeb },
  { id: "oidc", plugin: oidcWeb },
  { id: "projects", plugin: projectsWeb },
  { id: "push", plugin: pushWeb },
  { id: "routines", plugin: routinesWeb },
  { id: "slack", plugin: slackWeb },
  { id: "subagents", plugin: subagentsWeb },
  { id: "usage", plugin: usageWeb },
] as const;
