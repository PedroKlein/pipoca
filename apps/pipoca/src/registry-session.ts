// Written by `bun run registries` from plugins/*/package.json. Don't edit.
import { ask } from "../../../plugins/ask/plugin";
import { changes } from "../../../plugins/changes/plugin";
import { checklist } from "../../../plugins/checklist/plugin";
import gitHostsPackage from "../../../plugins/git-hosts/package.json";
import * as gitHostsSession from "../../../plugins/git-hosts/src/session";
import libraryPackage from "../../../plugins/library/package.json";
import * as librarySession from "../../../plugins/library/src/session";
import loginsPackage from "../../../plugins/logins/package.json";
import * as loginsSession from "../../../plugins/logins/src/session";
import metaPackage from "../../../plugins/meta/package.json";
import * as metaSession from "../../../plugins/meta/src/session";
import modelsPackage from "../../../plugins/models/package.json";
import * as modelsSession from "../../../plugins/models/src/session";
import routinesPackage from "../../../plugins/routines/package.json";
import * as routinesSession from "../../../plugins/routines/src/session";
import { subagents } from "../../../plugins/subagents/plugin";

export const sessionRegistry = [
  { id: "ask", definition: ask },
  { id: "changes", definition: changes },
  { id: "checklist", definition: checklist },
  {
    id: "git-hosts",
    manifest: gitHostsPackage.pipoca,
    session: gitHostsSession,
  },
  { id: "library", manifest: libraryPackage.pipoca, session: librarySession },
  { id: "logins", manifest: loginsPackage.pipoca, session: loginsSession },
  { id: "meta", manifest: metaPackage.pipoca, session: metaSession },
  { id: "models", manifest: modelsPackage.pipoca, session: modelsSession },
  {
    id: "routines",
    manifest: routinesPackage.pipoca,
    session: routinesSession,
  },
  { id: "subagents", definition: subagents },
] as const;
