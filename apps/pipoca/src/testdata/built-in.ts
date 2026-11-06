import type { ServerPlugin } from "@pipoca/plugins";
import { builtInServers } from "../built-in";

// A built-in v1 server part, for a test that runs it beside parts of its own.
export function builtInServer(id: string): ServerPlugin {
  const found = builtInServers().find(({ name }) => name === id);

  if (found === undefined) {
    throw new Error(`no built-in server part ${id}`);
  }

  return found;
}
