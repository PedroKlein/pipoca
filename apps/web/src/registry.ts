// Written by `bun run registries` from plugins/*. Don't edit.
import { web as askWeb } from "../../../plugins/ask/web/index";
import { web as changesWeb } from "../../../plugins/changes/web/index";
import { web as checklistWeb } from "../../../plugins/checklist/web/index";
import { web as emailWeb } from "../../../plugins/email/web/index";
import { web as gitHostsWeb } from "../../../plugins/git-hosts/web/index";
import { web as kubernetesWeb } from "../../../plugins/kubernetes/web/index";
import { web as localWeb } from "../../../plugins/local/web/index";
import { web as loginsWeb } from "../../../plugins/logins/web/index";
import { web as modelsWeb } from "../../../plugins/models/web/index";
import * as oidcWeb from "../../../plugins/oidc/web/index";
import { web as projectsWeb } from "../../../plugins/projects/web/index";
import { web as pushWeb } from "../../../plugins/push/web/index";
import * as routinesWeb from "../../../plugins/routines/web/index";
import { web as slackWeb } from "../../../plugins/slack/web/index";
import { web as subagentsWeb } from "../../../plugins/subagents/web/index";
import { web as usageWeb } from "../../../plugins/usage/web/index";

export const webRegistry = [
  { id: "ask", web: askWeb },
  { id: "changes", web: changesWeb },
  { id: "checklist", web: checklistWeb },
  { id: "email", web: emailWeb },
  { id: "git-hosts", web: gitHostsWeb },
  { id: "kubernetes", web: kubernetesWeb },
  { id: "local", web: localWeb },
  { id: "logins", web: loginsWeb },
  { id: "models", web: modelsWeb },
  { id: "oidc", plugin: oidcWeb },
  { id: "projects", web: projectsWeb },
  { id: "push", web: pushWeb },
  { id: "routines", plugin: routinesWeb },
  { id: "slack", web: slackWeb },
  { id: "subagents", web: subagentsWeb },
  { id: "usage", web: usageWeb },
] as const;
