---
title: Testing and installing
description: Test a plugin on the real server in memory, install it, and the limits it runs under.
sidebar:
  order: 6
---

## Test it

`testPlugin(server, { people, config, plugins, fetch, env })` from `@pipoca/testing` runs the plugin on the real server, with its own database in memory, the plugin's tables and the people you name. What it returns drives it:

- `as(personId)` calls its routes as that person, and `public()` as a browser signed in to nothing.
- `session({ owner })` starts a Session with a stand-in host that you take `online(false)` and back, and `tool(name, input, { session })` calls a tool as that Session does.
- `clock.advance("1h")` moves time so its schedules fire, and `restart()` starts a new server on the same database.
- A request the plugin makes to another server fails unless `fetch` answers it, and `env` is what it reads from the environment.

```ts
import { testPlugin } from "@pipoca/testing";
import { server } from "./server";

const t = await testPlugin(server, { people: [{ id: "ana" }] });

expect(await t.as("ana").get("greeting")).toEqual({ greeting: "Hello" });
```

`testSession(session)` runs a Session part against a stand-in Pi, and `until(check)` waits for something; a web test imports it from `@pipoca/testing/until`. Web parts render with `renderPart` from `@pipoca/plugins/web/testing`, by slot name, or `"settings"` for the part's Settings section. Run tests with `bun test` from the repository's root, whose setup gives `testPlugin` the server.

## Install it

There are three ways to put a plugin on a server, and each one installs it turned off:

- **From git**: paste the repository's URL on the Plugins page. A branch, tag or commit after `#` pins it, for example `https://github.com/you/greeter.git#v1.0.0`. The plugin's `package.json` has to be at the top of the repository.
- **From a tarball**: paste a `.tgz` URL. It must hold one folder, as `npm pack` makes.
- **In place**: ask the Pipoca assistant to write one. It writes the files into the plugins folder and builds them, but it can't turn the plugin on.

You can also put the folder in the server's plugins folder yourself (`--plugins`, next to the database by default), or link it there from where you develop it.

Then select **Turn on**. The confirm lists where its parts will run. Restart the server from the banner that appears. A plugin installed from git or a tarball can be updated to the newest version at its URL. A new version that adds a part is turned off until you turn it on again. An installed plugin can't sign people in. [Plugins](../admin/plugins.md) covers what admins see.

## Know the limits

- A plugin runs with the server's own access. Nothing sandboxes it, so turn on only plugins you trust.
- The server installs dependencies with `bun install --ignore-scripts` and builds with Bun macros off. A plugin can't use `workspaces`, `patchedDependencies`, `workspace:` or `link:` dependencies, a dependency from a path outside its folder, a `bunfig.toml`, or an `.npmrc`.
- A fetched plugin can't contain symlinks, and a URL can't contain credentials. Use an ssh URL with a key for a private repository.
- `@pipoca/plugins` isn't on npm yet. A running part gets it from the server, but its types and `@pipoca/testing` come from a checkout of the Pipoca repository.
- Parts run from `.build` in the plugin's folder, so a part that reads files next to itself through `import.meta.url` should look one folder up.
