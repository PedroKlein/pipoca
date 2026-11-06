# Pipoca architecture

How the parts of Pipoca fit together today. The words are defined in [concepts.md](concepts.md), and each decision has its reasons in [adr/](adr/).

## Processes

```text
browser ──HTTP/SSE──▶ pipoca server ◀──long poll + HTTPS/SSE── pipoca agent ──▶ one process per Session
                      (web app, API,                            (a runner on a laptop,
                       SQLite, pipoca.json)                      VM, container host or pod)
```

| Process             | What it does                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `pipoca server`     | Serves the web app and the API, keeps state, routes commands and runs server plugin parts   |
| `pipoca agent`      | A runner: joins an Environment's pool, takes Sessions, keeps their Workspaces and terminals |
| `pipoca session`    | One Pi Session with its Profile, the Pipoca Session host and every Session plugin part      |
| Project coordinator | A Pi Session that reads a Project's goal, starts threads and gets their reports             |

The server makes no product or code decisions. A coordinator is a Session like any other and goes through the same routes.

One binary is all of these. The server can run a runner itself (`--provider`), and the `local` and `kubernetes` plugins start runners on demand, so a solo install or a cluster needs no agent started by hand ([ADR 0053](adr/0053-ways-to-run-pipoca.md), [ADR 0032](adr/0032-environments-and-runners.md)).

## Runners and Sessions

- A runner connects out to the server, so a laptop needs no open port. It long-polls `/runner/work` for about 10 seconds at a time; the poll is also its heartbeat, and the server marks it offline 30 seconds after its last one ([ADR 0006](adr/0006-provider-protocol.md)).
- Each Session runs in its own process on the runner ([ADR 0017](adr/0017-process-per-session.md)). Its Pi JSONL transcript is the outbox: the runner posts lines with their numbers to `/runner/sessions/<id>/transcript`, and the server keeps a copy and replays it to browsers.
- Commands from the browser go to the Session over its event stream. Each run of a Session has a generation, and the server drops writes from an older one.
- A runner that can't reach the server for 30 seconds stops its Sessions. A clone Session can then resume on another runner of the pool from its transcript and its pushed branch.
- What a process doesn't survive, such as a running shell command or a turn in progress, shows as interrupted.

## Server

- **One route table.** `packages/protocol/src/routes.ts` declares every route with its method, path, auth level, TypeBox schemas, change topics and the tool it serves, if any ([ADR 0068](adr/0068-clean-rebuild.md#code-shape)). The router checks auth and bodies and answers errors as `{ error, message }` ([ADR 0047](adr/0047-api-errors-and-removal.md)). The web app, runners, MCP and the assistant's tools all call routes by name through a client made from it.
- **Change topics.** A route names the topics it changes, and browsers listen on `GET /api/changes` to refetch what changed instead of polling.
- **Plugins.** The plugin host loads each plugin that is turned on: built-in ones from generated registries, installed ones bundled from the plugins folder when the server starts. The kernel names no plugin. A plugin's routes sit under `/api/ext/<id>/` for people and `/runner/sessions/<id>/ext/<plugin>/` for its Session part ([ADR 0069](adr/0069-plugin-sdk-v2.md)).
- **Domain packages.** People, environments, sessions, profiles, repositories, workspaces, the runner, the Session host and the plugin host each live in `packages/`. `apps/pipoca` wires them together with SQLite and HTTP ([ADR 0008](adr/0008-monorepo-layout.md)).

## State

| Where          | What                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| SQLite         | People, browser sign-ins, Environments, runner tokens, Sessions, transcript copies, the outbox, schedules |
| `pipoca.json`  | Server options, plugin switches and config, templates; secrets sealed or named by environment variable    |
| Config folders | Profiles, My defaults, routines, each plugin's own files                                                  |
| Runner         | Workspaces, the Session's own Pi files, terminals                                                         |

Tables are `STRICT`, ids are UUIDv7, times are integer milliseconds, and every reference has a foreign key ([ADR 0068](adr/0068-clean-rebuild.md#storage)). The kernel and each plugin declare their schema as version 0 and a list of migrations after it. The server records each owner's version and runs the migrations a database hasn't at start. A database from a newer Pipoca refuses to start, and a plugin whose migration fails fails until an admin resets its data ([ADR 0070](adr/0070-schema-migrations.md)).

Messages for a Session that isn't running wait in the kernel's outbox, and plugin timers are rows in one schedule table, so both survive a restart. Each outbox row has a seq that the Session's host acknowledges, and a row stays until then: a new command stream gets every unacknowledged row again, and the host drops a seq it has seen.

## Web app

The web app is React with no router or query library ([ADR 0020](adr/0020-web-stack.md)). It has three pieces of its own:

- a route table of hash addresses, such as `#<session id>`, `#settings/<page>` and `#plugin/<name>/<path>`, with typed link builders (`apps/web/src/router.tsx`);
- one typed client for the server's routes and a keyed query store that change topics refresh (`apps/web/src/data/`);
- the components in `@pipoca/ui`, which plugins use too ([design-system.md](design-system.md)).

Settings is grouped by who it is for: your own pages, your Environments and Profiles, and the server's pages for admins ([ADR 0063](adr/0063-settings-and-first-run-setup.md)).

## Where it runs

- **Solo.** `pipoca up` runs a server for one person, with Sessions on the same machine. `pipoca connect` reaches a solo server on another machine over SSH and adds the laptop as a runner.
- **Team server.** `pipoca server` on a VM or in Kubernetes with the Helm chart, behind HTTPS. Runners join with an Environment's key, or the `kubernetes` plugin starts pods ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)).
- **Desktop app.** Runs `pipoca up` or `pipoca connect` for you ([ADR 0055](adr/0055-desktop-app.md)).

### v1 topology

The first version ran the server on a VM with a built-in runner, and a laptop runner reached it through an SSH tunnel, with no sign-in ([ADR 0005](adr/0005-v1-access-and-model-credentials.md), [ADR 0009](adr/0009-vm-deployment-and-testing.md)). `pipoca connect` does the same today, signed in.
