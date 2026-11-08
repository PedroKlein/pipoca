---
title: Plugins overview
description: What a Pipoca plugin is, its three parts, and how it is defined.
sidebar:
  order: 1
---

A plugin adds a feature to Pipoca for everyone on one server. It can answer HTTP routes, register tools and run schedules on the server, add pages and parts to the web app, and add commands, tools and Pi extensions to Sessions. The built-in plugins in [`plugins/`](../../plugins) use the same SDK as the ones you install, so Projects, the diff view, routines and Kubernetes runner pods are all examples of what one can do ([ADR 0069](../adr/0069-plugin-sdk-v2.md)).

The example in [`examples/plugins/greeter`](../../examples/plugins/greeter) has all three parts, and a test installs and runs it on every change. The [tutorial](tutorial.md) builds it step by step.

## The folder

A plugin is a folder with a `package.json`. Its `pipoca` field names the plugin's id and the file that defines it:

```json
{
  "name": "pipoca-greeter",
  "version": "1.0.0",
  "type": "module",
  "description": "Greets you on its own page and with /greet in a Session.",
  "pipoca": { "id": "greeter", "entry": "plugin.ts" }
}
```

The parts are found by where they live:

| File             | Export                          | Runs                                       | Page                           |
| ---------------- | ------------------------------- | ------------------------------------------ | ------------------------------ |
| `plugin.ts`      | the `definePlugin` definition   | nowhere: the other parts import it         | [below](#define-it)            |
| `src/server.ts`  | `server`, from `defineServer`   | in the server's process                    | [The server part](server.md)   |
| `src/session.ts` | `session`, from `defineSession` | in every Session's process, on any machine | [The Session part](session.md) |
| `web/index.tsx`  | `web`, from `defineWeb`         | in the browser                             | [The web part](web.md)         |

Every part is optional. The server bundles each one with its npm `dependencies`, so there's no build step of your own. `version` is optional and shows on the Plugins page.

Markdown files in a `docs` folder beside `package.json` reach every Session while the plugin is on, under `plugins/<id>/` in the Session's docs folder, so agents can read how to use it.

## Define it

`plugin.ts` exports the definition and nothing that runs:

```ts
import { Config, definePlugin } from "@pipoca/plugins";

export const greeter = definePlugin({
  id: "greeter",
  title: "Greeter",
  description: "Greets you on its own page and with /greet in a Session.",
  config: Config.object({
    greeting: Config.string({ title: "Greeting", default: "Hello" }),
  }),
});
```

- `config` is the plugin's key in the server's `pipoca.json`, which admins edit on the Plugins page. Build it with `Config.object`, `Config.string`, `Config.number`, `Config.bytes`, `Config.boolean`, `Config.choice`, `Config.strings`, `Config.collection`, `Config.audience` and `Secret()`. `Config.bytes` is a size the settings form shows in MB or GB, and an object given a `title` shows as a group of its own fields. A secret is stored sealed, or as `{ "env": "NAME" }` for config kept in git.
- `schema` is SQL for the plugin's tables. Name them `<id>_<table>`, with a hyphen in the id written as an underscore, make them `STRICT`, keep times as integer milliseconds and ids as UUIDv7 (`Bun.randomUUIDv7()`). A table may reference the plugin's own tables and `users`, `sessions` and `environments`. Once a version with it is out, never edit `schema`: add to `migrations` instead.
- `migrations` is a list of SQL run in order after `schema`, each one version more. The server runs the ones a database hasn't at start, inside its transaction, so a table rebuild uses `pragma defer_foreign_keys = on`. If one fails, or the database is at a newer version, the plugin fails with its data kept until an admin resets it on the Plugins page ([ADR 0070](../adr/0070-schema-migrations.md)).
- `events` declares what the plugin emits, each with a `title` and TypeBox `fields`, so routines can offer it as a trigger.
- `actions` declares what a routine's runs may propose for the plugin to write outside, each with a `title` and a TypeBox `input`, made with `action()` ([ADR 0076](../adr/0076-routine-runs-questions-actions-and-guards.md#allowed-actions)). `commits: true` marks one that takes the commits on the run's workspace branch, as a pull request does. The server part applies them ([Actions and destinations](server.md#actions-destinations-and-checks)).
- `destinations` declares where a routine run's result can go when the run ends, each with a `title` and TypeBox `settings`, made with `destination()` ([ADR 0075](../adr/0075-routines-groups-coordinators-and-agents.md#results-can-go-somewhere-by-themselves)).
- `checks` declares checks a routine's trigger can use by name, each a `title`, a `script` that returns true or false and optional TypeBox `settings`, made with `check()`. The script sees `event`, `earlier` and `settings`, and runs in the routines plugin's sandbox.
- `requires` lists the plugins it can't run without. They start first, and it fails while one is off. Turning one of them off turns this plugin off too, after a confirm. List only plugins most of it breaks without: one it merely listens to or acts through shows as "works with" by itself ([ADR 0077](../adr/0077-plugin-dependencies.md)).
- `modelCredentials: true` says its Session part keeps the Session's model and MCP logins with `provide.modelCredentials`. Only one plugin on a server may say so: another that does fails at start, and a Session part that keeps them without it fails.
- `defaultOn` says whether a built-in plugin starts on: `always`, `solo`, `team` or `never`.

## Rules every plugin follows

- A plugin imports only `@pipoca/plugins`, `@pipoca/plugins/web`, `@pipoca/protocol`, `@pipoca/ui` and another plugin's definition as `@pipoca/<id>/plugin`, plus its own npm `dependencies`. The Pipoca packages come from the server it runs on, so don't list them in `dependencies`.
- It tells time with `clock.now()` and waits with `schedule` or `timer`, never `Date.now()` or `setTimeout`, so its tests can move time. The repository's lint enforces both.
- A plugin runs with the server's own access. Nothing sandboxes it, so admins turn on only plugins they trust.

## Personal and team work

Team Sessions load a plugin's tools and its Session and web parts while an admin leaves it on in Team setup's **Plugins in team work**. Built-in plugins start on there, installed ones off ([ADR 0067](../adr/0067-team-plugins-projects-and-assistant.md)). A route answers team callers only with `team: true` ([The server part](server.md#routes)), and the SDK gives the plugin each caller's owner, a person or the team, to guard its own tables with.

## Next

Follow the [tutorial](tutorial.md), then read each part's page. [Testing and installing](testing-and-installing.md) covers tests, the three ways to install and the limits.
