// Written by `bun run registries` from plugins/*. Don't edit.
import { web as askWeb } from "../../../plugins/ask/web/index";
import { web as changesWeb } from "../../../plugins/changes/web/index";
import { web as checklistWeb } from "../../../plugins/checklist/web/index";
import * as emailWeb from "../../../plugins/email/web/index";
import * as gitHostsWeb from "../../../plugins/git-hosts/web/index";
import * as kubernetesWeb from "../../../plugins/kubernetes/web/index";
import * as libraryWeb from "../../../plugins/library/web/index";
import * as localWeb from "../../../plugins/local/web/index";
import * as loginsWeb from "../../../plugins/logins/web/index";
import * as metaWeb from "../../../plugins/meta/web/index";
import { web as modelsWeb } from "../../../plugins/models/web/index";
import * as oidcWeb from "../../../plugins/oidc/web/index";
import * as projectsWeb from "../../../plugins/projects/web/index";
import * as pushWeb from "../../../plugins/push/web/index";
import * as routinesWeb from "../../../plugins/routines/web/index";
import * as slackWeb from "../../../plugins/slack/web/index";
import { web as subagentsWeb } from "../../../plugins/subagents/web/index";
import * as usageWeb from "../../../plugins/usage/web/index";

export const webRegistry = [
  { id: "ask", web: askWeb },
  { id: "changes", web: changesWeb },
  { id: "checklist", web: checklistWeb },
  { id: "email", plugin: emailWeb },
  { id: "git-hosts", plugin: gitHostsWeb },
  { id: "kubernetes", plugin: kubernetesWeb },
  { id: "library", plugin: libraryWeb },
  { id: "local", plugin: localWeb },
  { id: "logins", plugin: loginsWeb },
  { id: "meta", plugin: metaWeb },
  { id: "models", web: modelsWeb },
  { id: "oidc", plugin: oidcWeb },
  { id: "projects", plugin: projectsWeb },
  { id: "push", plugin: pushWeb },
  { id: "routines", plugin: routinesWeb },
  { id: "slack", plugin: slackWeb },
  { id: "subagents", web: subagentsWeb },
  { id: "usage", plugin: usageWeb },
] as const;
