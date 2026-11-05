# 0068: Clean rebuild

- Status: accepted
- Date: 2026-11-05

## Context

Pipoca's features have settled after 67 ADRs, but the code grew one feature at a time. State is spread across SQLite, `pipoca.json`, folders and hardcoded values, sometimes with the same fact in two places. "Who owns this" is stored five different ways. The plugin SDK passes kernel internals straight through, so plugins rebuild routing, config with secrets, tables, timers and delivery queues by hand. The server keeps every route in one regex table and defines each request shape three times. The web app has no route table or data layer, and the mockups' components are written again on each screen.

Nobody runs Pipoca yet except its author. Nothing depends on the SDK, the HTTP API or the database. This is the cheapest moment there will ever be to change them.

## Decision

Rebuild the codebase in slices on a `rebuild` branch, with no backwards compatibility, and merge it to `main` once at the end.

### How

- Each slice is one reviewed pull request into `rebuild` that keeps format, lint, typecheck, unit and browser tests green. `main` and running installs stay on the old code until the final merge.
- Rewrite in place, layer by layer, not from an empty repository. The black-box HTTP tests and the browser tests carry over and prove that behavior survives.
- [Rebuild acceptance list](../acceptance/rebuild.md) lists every feature to keep. A slice is done when the features it touches still work. The rebuild adds no features: items marked not built stay not built.
- Review rounds after the database, after the SDK, after the plugins and at the end. Each round has separate reviews for correctness, for conformance with this list and the ADRs, and for simplicity.

### Storage

- [ADR 0039](0039-plugin-config-files.md) is the one rule: config people set ahead of time goes in `pipoca.json` and folders, runtime data in SQLite, and secrets are sealed or named by environment variable through one `SecretRef` shape.
- The database starts from scratch with no migrations. An existing database made by older code refuses to start and says to move it aside.
- The kernel and each plugin declare their schema. The kernel creates it, records a hash per owner, and marks a plugin failed when its schema changed, with an admin action to reset that plugin's data.
- Tables are `STRICT`, ids are UUIDv7, times are integer milliseconds, money is integer micro-dollars, and every reference has a foreign key, including plugin tables that point at kernel tables.
- Plugin settings, plugin on/off state and Kubernetes template settings move into `pipoca.json`. One kernel outbox holds messages for Sessions that aren't running.

### One model, one name

- An owner is a person or the team, everywhere. SQL stores `owner_user_id`, with NULL for the team. TypeScript has one `Owner` type. The kernel scopes every list and read by the viewer.
- A Session's owning plugin is its `plugin` (with a key), the person who started it is its `startedBy`, and who its git acts as is its `actsAs`. None of these is called owner.
- A process that runs Sessions is a runner, in code, routes and UI copy. Team lines in a Session are messages, with targets To Pi, To the team and Off the record.
- The repository manifest gets its own file name, so `pipoca.json` means only the server's config file.
- Actors are `user:<id>`, `session:<id>` and `plugin:<id>`.

### Code shape

- TypeBox schemas in `protocol` are the single source of every wire shape. Types, validation, the typed client and MCP tool schemas all come from them.
- One route table on the server declares each route's auth level, schemas, change topics and long-request flag. The router does auth, validation and errors. The web app, runner, CLI and toolsets use a client generated from it.
- Domain logic lives in domain packages (people, environments, sessions, profiles, repositories, runner, pluginhost). `apps/pipoca` keeps adapters and wiring.
- Plugins are declared with one `definePlugin`: typed config with secrets, declared tables, typed events with their audience, routes with an auth level, one kind of tool, durable scheduling and delivery. Code in the kernel that only one plugin needs moves into that plugin.
- The web app keeps [ADR 0020](0020-web-stack.md): no router or query library. It gets an in-house route table, a keyed cache refreshed by change topics, and a component library covering the settings and team mockups. `pipoca.css` and [design-system.md](../design-system.md) are the one design source.

### What goes

- All migration and compatibility code, the `pi-cloud` names and paths, and code for superseded decisions.
- The meta plugin. The assistant is a Project ([ADR 0052](0052-the-assistant-as-a-project.md)).
- Kubernetes Environments made outside templates.
- The library becomes part of the Projects plugin.

### Loose ends settled by keeping today's behavior

Where two ADRs disagree, the rebuild keeps what the code does today and records it:

- Each container Session gets its own container ([ADR 0032](0032-environments-and-runners.md)). A pool sharing one container stays unbuilt.
- A new Session's model is chosen the way the code chooses it today; [ADR 0019](0019-model-aliases.md) and [ADR 0063](0063-settings-and-first-run-setup.md) are read together through that code.
- `GH_TOKEN` stays as the github.com fallback ([ADR 0043](0043-git-hosts.md)).
- Routines end runs with `end_run` (done, nothing, blocked). [ADR 0059](0059-routines-and-wake-ups.md)'s `report_nothing` is replaced.
- The team ADRs (0054, 0065, 0066, 0067) are built as far as the acceptance list says, not direction only.

## Consequences

- Kyma's data is wiped when the rebuild is deployed. Profiles, routines and config in folders survive; Sessions, people and logins don't.
- Fixes merged to `main` during the rebuild must be carried over to `rebuild` by hand.
- Plugin authors outside this repository, if any appear, must port to the new SDK. The SDK is not frozen yet ([ADR 0046](0046-plugin-sdk-from-the-server.md) still applies).
- Schema changes after the rebuild need migrations again once someone runs Pipoca with data worth keeping. That is a later ADR.
