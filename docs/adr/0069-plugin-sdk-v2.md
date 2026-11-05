# 0069: Plugin SDK v2

- Status: accepted
- Date: 2026-11-05

## Context

The clean rebuild ([ADR 0068](0068-clean-rebuild.md)) replaces the plugin SDK, which passed kernel internals straight to plugins. The first v2 ports (ask, changes, checklist, subagents and models) showed where the new SDK was still loose. A plugin named its parts twice, once as files and once as loaders in its definition. The public index exported what only the host uses. Server and Session tools had two types. A route's caller and params were untyped, so plugins wrote `personOf` and `sessionOf` casts. Tests reached for globals to find the host. A part named its own topics by the full `<plugin>.<name>`. The context also declared surface no plugin uses yet, such as `provide.runtime`, which only threw.

## Decision

- **Parts by convention.** A plugin is `plugin.ts` with one `definePlugin` and no loaders. Its parts are the named exports `server` in `src/server.ts`, `session` in `src/session.ts` and `web` in `web/index.tsx`. The registries, the bundler and installed plugins all find them there. `register` is synchronous.
- **A narrow public SDK.** `@pipoca/plugins` exports what a plugin writes against. What only the host and kernel use, such as `readJson`, `toolSpecOf`, `transcriptReader`, `secretRefs` and the config and event helpers, comes from `@pipoca/plugins/host`.
- **One ToolDef.** A tool is one `ToolDef` with TypeBox `params`, `prompt`, `sequential`, `when` and `asks`. It runs on the server, or in the Session as a `SessionTool`. A Session tool can't have `when`, since the Session part already runs where it applies.
- **Typed routes.** `auth` decides the caller's type: `PersonCaller`, `SessionCaller` or `PublicCaller`. `params` take their names from the path. A person route answers 403 to a Session that calls it. A route returns 201 or 202 with `status`. A route body that doesn't fit its schema answers 422 and names the field.
- **Team routes.** `team: true` on a person route also mounts it for team work, with `caller.owner` set to `"team"`. It replaces `routes.scoped`.
- **Capabilities are inferred.** The host records which parts of the context a server part touches while it registers. Plugins declare no `capabilities`, and no `Proxy` guards the context.
- **Testing is its own package.** `@pipoca/testing` has `testPlugin` and `testSession`. `testPlugin` is typed by the plugin's config, disposes with `await using`, and has a clock that can be frozen. `send` and `online(true)` return once the message is delivered. `@pipoca/plugins/web/testing` has `renderPart` and `sessionWith` for web parts.
- **Topics are named once.** A part watches its plugin's changes through `useLoaded(..., { changes })` and `useTopic` by the names its routes give them. Another plugin's topic is `<plugin>.<name>`.
- **Surface comes with its first user.** Providers other than `models` and `profile`, `Urls.cookie`, `Secrets.token` and `hash`, Session bindings, `cancelPrefix`, Profiles and the runner parts of `environments` are left out. Each comes back in the port that first uses it. `ctx.timer` gives in-memory waits, such as a long poll, that need not survive a restart.
- **No plugin is special.** Tests check that the kernel names no plugin id and imports no plugin outside the generated registries. Other tests boot a server with every plugin off, and with each plugin off alone.
- The checklist draws in the `session.composer` slot. Slots are named `<area>.<place>`.

## Consequences

- This supersedes `readJson` and the 400 for a bad body in [ADR 0048](0048-typebox-checks-in-plugins.md), declared capabilities in [ADR 0022](0022-plugin-model-v2.md) and [ADR 0036](0036-plugin-settings.md), and the `composer` slot name in [ADR 0056](0056-session-checklist.md).
- A plugin ported on an earlier branch moves its parts to the convention paths and imports host helpers from `@pipoca/plugins/host`. It takes `testPlugin` from `@pipoca/testing`, and declares `team: true` in place of `scoped`.
- The ports of email, git-hosts and kubernetes add back Session bindings, cookies, `gitCredentials`, `runners` and `templateConfig`, each with its user.
- `config.watch` still polls `pipoca.json`, since nothing tells the host when the file changes yet.
- Until their plugins are ported, the kubernetes, projects and two sessionhost tests stay exempt from the lint against importing plugins.
