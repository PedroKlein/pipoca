---
title: The server part
description: Routes, tools, tables, schedules, events and what else a plugin gets on the server.
sidebar:
  order: 3
---

`src/server.ts` exports `server`, made with `defineServer`. Its function runs once, synchronously, when the plugin starts, in the server's process:

```ts
import { defineServer } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const server = defineServer(greeter, ({ config, routes }) => {
  routes.get("greeting", { auth: "person" }, () => ({
    greeting: config.get().greeting,
  }));
});
```

## Routes

`routes.get`, `post`, `put`, `patch` and `delete(path, spec, handler)` answer `/api/ext/<id>/<path>`. `:name` in the path is a param.

- `spec.auth` is `"person"`, `"admin"`, `"session"` (the plugin's own Session part), `"public"` or `{ webhook: { secret } }`.
- `body` and `query` are TypeBox schemas: a request that doesn't fit gets a 422 that names the field.
- `changes: ["items"]` tells open pages that `items` changed once the route succeeds.
- `team: true` also answers at `team/<path>` with the team as the caller's owner, while the plugin is on in team work.
- `tool: { name, description }` also makes the route a tool. A team Session gets the tool only when the route has `team: true`, and then calls its team half.

The handler gets `{ caller, params, body, query, raw }` and returns a value, sent as JSON, or a `Response`. Throw `BadRequest`, `Forbidden`, `NotFound` or `HttpError(status, message, code?)` to answer with that status and `{ "error": code, "message": message }` ([ADR 0047](../adr/0047-api-errors-and-removal.md)). Name a route for what it serves and let the method say what happens to it.

## Tools

`tools.define({ name, description, params, run })` adds a tool to Sessions, with `when` to pick which. A tool with `annotations: { openWorld: true }` writes outside Pipoca, such as a Slack post. A Session that proposes, such as a routine run fired by outside input, doesn't get it unless it is also `readOnly`.

## Storage

- `store` is the plugin's tables: `all`, `get`, `run` and `transaction`. `secrets` seals what it keeps in them.
- `dataDir` is a folder of the plugin's own on the server's data volume for files it writes as it works, such as a routine group's memory. It may not exist yet.
- `blobs` keeps bytes in a folder of the plugin's own on the server's data volume, each file named by its SHA-256: `put`, `size`, `read` (a stream), `bytes` and `remove`, and `space()` says what the folder takes and what's free on its volume. The plugin's rows hold the hashes they use, and it removes a hash once none does. `acceptUploads({ maxBytes })` lets its Session part send files with `s.blobs.upload(path)`, and people's browsers through `blobRoutes.browserUpload`, in 8 MB chunks that carry on after a dropped connection ([ADR 0078](../adr/0078-artifacts-and-session-files.md)). In a web part, `uploadBlob(api, file, onProgress)` from `@pipoca/plugins/web` sends a file that way and resolves to its hash for the plugin's own route to name.
- `config.get()`, `config.set(change)` and `config.watch(fn)` read and change its key in `pipoca.json`. `config.collection(name)` edits a collection in it by key.

## Time

`schedule.at(key, time, data)` and `schedule.every(key, ms, run)` run work later, and survive a restart. `timer` waits in memory, for a long poll. `clock` tells the time. Never use `Date.now()` or `setTimeout`, so tests can move time.

## Calling out

Plugins call other servers through `network`, never the global `fetch`, which the lint refuses ([ADR 0080](../adr/0080-private-hosts-reached-through-environments.md)).

- `network.fetch(url, init, { owner, action })` works like `fetch`. A call to a host an admin listed as private goes through an online runner of one of the owner's Environments that reaches it: a person's own for a person, a team Environment for `"team"`. `action` names what the call does in a few words, such as `"repo picker search"`, and the Environment's Recent relays show it. Other calls go straight out, and need neither.
- `network.env(url, { owner, action })` gives the variables that send a child process such as git to that host the same way, and `done()` ends them once the process exits.
- `network.privateHost(url)` says whether the URL is on a listed private host, and whether team routines may watch it.
- With no route, both throw `Unreachable`, a 409 with the code `unreachable` and the host, which routes answer as is.

## Sessions and what the kernel keeps

- `sessions` starts, lists, messages and archives Sessions. The ones it starts with a `key` are its own, and show inside its page rather than in the Session list. `sessions.need(id, key, { for })` makes a Session wait for a person, in Needs you and with a notification, for something the plugin keeps itself, until `sessions.need(id, key, null)` clears it.
- `people`, `transcript`, `environments` and `profiles` read what the kernel keeps.
  - `profiles.baseProviders()` lists the model providers the base Profile's packages register, as the server last listed them.
  - `profiles.stacked(personId, profileId, team)` reads a Profile the person sees, with every layer under it, as text by path, and `profiles.write(personId, profileId, team, files)` writes files into one they may change. With `team`, only team Profiles count.
  - `environments.templateConfig(schema)` reads and writes the plugin's key in a template's entry, with the schema's defaults filled.

## Events

`events.on(def, handler)` hears another plugin's or the kernel's events, and `events.emit(name, fields, { to })` sends its own, declared in `plugin.ts`, to the owners in `to`. Routines offer every declared event as a trigger.

## Actions, destinations and checks

- `provide.actions({ name: (input, { session, commits }) => ... })` applies each action the plugin declares, writing as the identity the run's Session acts as, and returns `{ text, url? }`. `actions.declared()` and `actions.apply(type, input, call)` reach every enabled plugin's actions.
- `provide.destinations({ name: (settings, delivery) => ... })` delivers a routine run's result to each destination it declares. `delivery` has the run's `session`, the `routine`'s title, the `outcome`, the `summary`, any `output`, the run's `events` and the result as plain `text`, and it returns `{ text, url? }`. `destinations.declared()` and `destinations.deliver(type, settings, delivery)` reach every enabled plugin's destinations.
- `checks.declared()` lists every enabled plugin's checks.

## Questions

`questions` reaches the questions that wait past the turn ([ADR 0076](../adr/0076-routine-runs-questions-actions-and-guards.md)).

- `questions.wait(sessionId, { origin, owner, for, timeoutMs })` makes the `ask_user` questions of a Session the plugin started end the turn instead of holding it open. Each waits in Needs you, and where `origin` (the event the work came from) says, until it is answered or times out, and its answer comes to the Session as a message that names the question.
- `questions.open(sessionId)` lists the open ones, and `questions.answer(id, { text, by })` answers one.
- `questions.ask(sessionId, { questions, defaults, for })` asks from the server in such a Session, as the Routines plugin asks for an approval.
- `provide.replies({ post })` is how a plugin that publishes events posts a question back where one of them came from, such as a comment on the issue. It answers false when it can't, and later hands the replies people write there to `questions.answer`.

One plugin per server keeps the questions with `provide.questions`, which the Ask plugin does. The Ask plugin publishes `ask.answered` when a question is answered or times out.

## What a plugin gives the kernel

`provide.models`, `provide.runners`, `provide.runtime`, `provide.gitCredentials` and `provide.profile` give the kernel models, runners and logins. `provide.runners` returns what a runner provider needs: `unplaced`, `token` and `revoke`. Its `kind.choice`, such as "A pod for each person", is how Where Sessions run in server setup offers a template whose runners it starts.

## Everything else

- `urls.public(path)` is a route's address from outside, and `urls.browser` ties an OAuth state to the browser that started it.
- `env` is what it reads from the environment, `log` logs, and `signal` aborts when the server stops.
