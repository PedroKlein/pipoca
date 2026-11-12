import type { PluginHost } from "@pipoca/pluginhost";
import type { Log, RouteKey, ServerUse } from "@pipoca/protocol";
import type { Profiles } from "@pipoca/profiles";
import type { Sessions } from "@pipoca/sessions";
import type { People, SignIn } from "@pipoca/people";
import type {
  Environments,
  RunnerCredentials,
  Templates,
} from "@pipoca/environments";
import type { Changes } from "../../changes";
import type { ConfigFiles } from "../../config";
import type { Hub } from "../../hub";
import type { NewcomerSetup } from "../../newcomers";
import type { NetworkRouter } from "../../network";
import type { PrivateHostList } from "../../private-hosts";
import type { Team } from "../../team";
import type { Callers } from "./router";

interface ServerRestart {
  // Sessions on the server's own runner that are mid-turn.
  readonly busy: () => number;
  readonly now: () => void;
}

// Who the server is for, under "server" in pipoca.json (ADR 0072).
interface ServerFor {
  readonly usedBy: () => ServerUse | undefined;
  readonly use: (usedBy: ServerUse) => void;
  // A solo install is just for its own person.
  readonly solo: boolean;
}

// Who calls the server: people signed in, and runners with their tokens.
export interface Auth {
  readonly people: People;
  readonly signIn: SignIn;
  readonly runners: RunnerCredentials;
}

// Everything the routes reach.
export interface ApiDeps {
  readonly people: People;
  readonly signIn: SignIn;
  readonly runners: RunnerCredentials;
  readonly sessions: Sessions;
  readonly environments: Environments;
  readonly profiles: Profiles;
  readonly plugins: PluginHost;
  readonly changes: Changes;
  readonly callers: Callers;
  readonly checkStore: () => void;
  readonly log: Log;
  // The server's public URL, from --url.
  readonly url?: URL | undefined;
  readonly restart?: ServerRestart | undefined;
  readonly templates?: Templates | undefined;
  readonly config?: ConfigFiles | undefined;
  readonly hub?: Hub | undefined;
  readonly newcomers?: NewcomerSetup | undefined;
  readonly privateHosts?: PrivateHostList | undefined;
  readonly network?: NetworkRouter | undefined;
  readonly team?: Team | undefined;
  readonly serverFor?: ServerFor | undefined;
}

// The routes whose names start with a group, such as "sessions".
export type Group<Prefix extends string> = Extract<
  RouteKey,
  Prefix | `${Prefix}.${string}`
>;
