// Written by `bun run registries` from plugins/*. Don't edit.
import { ask } from "../../../plugins/ask/plugin";
import { session as askSession } from "../../../plugins/ask/src/session";
import { changes } from "../../../plugins/changes/plugin";
import { session as changesSession } from "../../../plugins/changes/src/session";
import { checklist } from "../../../plugins/checklist/plugin";
import { session as checklistSession } from "../../../plugins/checklist/src/session";
import { gitHosts } from "../../../plugins/git-hosts/plugin";
import { session as gitHostsSession } from "../../../plugins/git-hosts/src/session";
import loginsPackage from "../../../plugins/logins/package.json";
import * as loginsSession from "../../../plugins/logins/src/session";
import { models } from "../../../plugins/models/plugin";
import { session as modelsSession } from "../../../plugins/models/src/session";
import { projects } from "../../../plugins/projects/plugin";
import { session as projectsSession } from "../../../plugins/projects/src/session";
import routinesPackage from "../../../plugins/routines/package.json";
import * as routinesSession from "../../../plugins/routines/src/session";
import { subagents } from "../../../plugins/subagents/plugin";
import { session as subagentsSession } from "../../../plugins/subagents/src/session";

export const sessionRegistry = [
  { id: "ask", definition: ask, session: askSession },
  { id: "changes", definition: changes, session: changesSession },
  { id: "checklist", definition: checklist, session: checklistSession },
  { id: "git-hosts", definition: gitHosts, session: gitHostsSession },
  { id: "logins", manifest: loginsPackage.pipoca, session: loginsSession },
  { id: "models", definition: models, session: modelsSession },
  { id: "projects", definition: projects, session: projectsSession },
  {
    id: "routines",
    manifest: routinesPackage.pipoca,
    session: routinesSession,
  },
  { id: "subagents", definition: subagents, session: subagentsSession },
] as const;
