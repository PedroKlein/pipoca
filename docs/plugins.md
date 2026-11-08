# Writing a plugin

A plugin adds a feature to Pipoca for everyone on one server. It can answer HTTP routes, register tools and run schedules on the server, add pages and parts to the web app, and add commands, tools and Pi extensions to Sessions. The built-in plugins in `plugins/` use the same SDK as the ones you install ([ADR 0069](adr/0069-plugin-sdk-v2.md)).

The example in [`examples/plugins/greeter`](../examples/plugins/greeter) has all three parts, and a test installs and runs it on every change.

## Make the folder

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

| File             | Export                          | Runs                                       |
| ---------------- | ------------------------------- | ------------------------------------------ |
| `plugin.ts`      | the `definePlugin` definition   | nowhere: the other parts import it         |
| `src/server.ts`  | `server`, from `defineServer`   | in the server's process                    |
| `src/session.ts` | `session`, from `defineSession` | in every Session's process, on any machine |
| `web/index.tsx`  | `web`, from `defineWeb`         | in the browser                             |

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

- `config` is the plugin's key in the server's `pipoca.json`, which admins edit on the Plugins page. Build it with `Config.object`, `Config.string`, `Config.number`, `Config.boolean`, `Config.choice`, `Config.strings`, `Config.collection`, `Config.audience` and `Secret()`. A secret is stored sealed, or as `{ "env": "NAME" }` for config kept in git.
- `schema` is SQL for the plugin's tables. Name them `<id>_<table>`, with a hyphen in the id written as an underscore, make them `STRICT`, keep times as integer milliseconds and ids as UUIDv7 (`Bun.randomUUIDv7()`). A table may reference the plugin's own tables and `users`, `sessions` and `environments`. Once a version with it is out, never edit `schema`: add to `migrations` instead.
- `migrations` is a list of SQL run in order after `schema`, each one version more. The server runs the ones a database hasn't at start, inside its transaction, so a table rebuild uses `pragma defer_foreign_keys = on`. If one fails, or the database is at a newer version, the plugin fails with its data kept until an admin resets it on the Plugins page ([ADR 0070](adr/0070-schema-migrations.md)).
- `events` declares what the plugin emits, each with a `title` and TypeBox `fields`, so routines can offer it as a trigger.
- `actions` declares what a routine's runs may propose for the plugin to write outside, each with a `title` and a TypeBox `input`, made with `action()` ([ADR 0076](adr/0076-routine-runs-questions-actions-and-guards.md#allowed-actions)). `commits: true` marks one that takes the commits on the run's workspace branch, as a pull request does. The server part applies each with `provide.actions({ name: (input, { session, commits }) => ... })`, writing as the identity the run's Session acts as, and returns `{ text, url? }`. `actions.declared()` and `actions.apply(type, input, call)` reach every enabled plugin's actions.
- `destinations` declares where a routine run's result can go when the run ends, each with a `title` and TypeBox `settings`, made with `destination()` ([ADR 0075](adr/0075-routines-groups-coordinators-and-agents.md#results-can-go-somewhere-by-themselves)). The server part delivers to each with `provide.destinations({ name: (settings, delivery) => ... })`, where `delivery` has the run's `session`, the `routine`'s title, the `outcome`, the `summary`, any `output`, the run's `events` and the result as plain `text`, and returns `{ text, url? }`. `destinations.declared()` and `destinations.deliver(type, settings, delivery)` reach every enabled plugin's destinations.
- `checks` declares checks a routine's trigger can use by name, each a `title`, a `script` that returns true or false and optional TypeBox `settings`, made with `check()`. The script sees `event`, `earlier` and `settings`, and runs in the routines plugin's sandbox. `checks.declared()` lists every enabled plugin's checks.
- `requires` lists the plugins it can't run without. They start first, and it fails while one is off. Turning one of them off turns this plugin off too, after a confirm. List only plugins most of it breaks without: one it merely listens to or acts through shows as "works with" by itself ([ADR 0077](adr/0077-plugin-dependencies.md)).
- `modelCredentials: true` says its Session part keeps the Session's model and MCP logins with `provide.modelCredentials`. Only one plugin on a server may say so: another that does fails at start, and a Session part that keeps them without it fails.
- `defaultOn` says whether a built-in plugin starts on: `always`, `solo`, `team` or `never`.

A plugin imports only `@pipoca/plugins`, `@pipoca/plugins/web`, `@pipoca/protocol`, `@pipoca/ui` and another plugin's definition as `@pipoca/<id>/plugin`. They come from the server it runs on, so don't list them in `dependencies`. It tells time with `clock.now()` and waits with `schedule` or `timer`, never `Date.now()` or `setTimeout`, so its tests can move time. The repository's lint enforces both.

## The server part

```ts
import { defineServer } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const server = defineServer(greeter, ({ config, routes }) => {
  routes.get("greeting", { auth: "person" }, () => ({
    greeting: config.get().greeting,
  }));
});
```

The function runs once, synchronously, when the plugin starts. What it gets:

- `routes.get/post/put/patch/delete(path, spec, handler)` answers `/api/ext/<id>/<path>`. `:name` in the path is a param. `spec.auth` is `"person"`, `"admin"`, `"session"` (the plugin's own Session part), `"public"` or `{ webhook: { secret } }`. `body` and `query` are TypeBox schemas: a request that doesn't fit gets a 422 that names the field. `changes: ["items"]` tells open pages that `items` changed once the route succeeds. `team: true` also answers at `team/<path>` with the team as the caller's owner, while the plugin is on in team work. `tool: { name, description }` also makes the route a tool. A team Session gets the tool only when the route has `team: true`, and then calls its team half. The handler gets `{ caller, params, body, query, raw }` and returns a value, sent as JSON, or a `Response`. Throw `BadRequest`, `Forbidden`, `NotFound` or `HttpError(status, message, code?)` to answer with that status and `{ "error": code, "message": message }` ([ADR 0047](adr/0047-api-errors-and-removal.md)). Name a route for what it serves and let the method say what happens to it.
- `tools.define({ name, description, params, run })` adds a tool to Sessions, with `when` to pick which.
- `store` is the plugin's tables: `all`, `get`, `run` and `transaction`. `secrets` seals what it keeps in them.
- `dataDir` is a folder of the plugin's own on the server's data volume for files it writes as it works, such as a routine group's memory. It may not exist yet.
- `blobs` keeps bytes in a folder of the plugin's own on the server's data volume, each file named by its SHA-256: `put`, `size`, `read` (a stream), `bytes` and `remove`, and `space()` says what the folder takes and what's free on its volume. The plugin's rows hold the hashes they use, and it removes a hash once none does. `acceptUploads({ maxBytes })` lets its Session part send files with `s.blobs.upload(path)`, and people's browsers through `blobRoutes.browserUpload`, in 8 MB chunks that carry on after a dropped connection ([ADR 0078](adr/0078-artifacts-and-session-files.md)). In a web part, `uploadBlob(api, file, onProgress)` from `@pipoca/plugins/web` sends a file that way and resolves to its hash for the plugin's own route to name.
- `config.get()`, `config.set(change)` and `config.watch(fn)` read and change its key in `pipoca.json`. `config.collection(name)` edits a collection in it by key.
- `schedule.at(key, time, data)` and `schedule.every(key, ms, run)` run work later, and survive a restart. `timer` waits in memory, for a long poll.
- `sessions` starts, lists, messages and archives Sessions. The ones it starts with a `key` are its own, and show inside its page rather than in the Session list. `sessions.need(id, key, { for })` makes a Session wait for a person, in Needs you and with a notification, for something the plugin keeps itself, until `sessions.need(id, key, null)` clears it.
- `events.on(def, handler)` hears another plugin's or the kernel's events, and `events.emit(name, fields, { to })` sends its own to the owners in `to`.
- `people`, `transcript`, `environments` and `profiles` read what the kernel keeps. `profiles.baseProviders()` lists the model providers the base Profile's packages register, as the server last listed them. `profiles.stacked(personId, profileId, team)` reads a Profile the person sees, with every layer under it, as text by path, and `profiles.write(personId, profileId, team, files)` writes files into one they may change. With `team`, only team Profiles count. `environments.templateConfig(schema)` reads and writes the plugin's key in a template's entry, with the schema's defaults filled.
- A tool with `annotations: { openWorld: true }` writes outside Pipoca, such as a Slack post. A Session that proposes, such as a routine run fired by outside input, doesn't get it unless it is also `readOnly`.
- `provide.models`, `provide.runners`, `provide.runtime`, `provide.gitCredentials` and `provide.profile` give the kernel models, runners and logins. `provide.runners` returns what a runner provider needs: `unplaced`, `token` and `revoke`. Its `kind.choice`, such as "A pod for each person", is how Where Sessions run in server setup offers a template whose runners it starts.
- `questions` reaches the questions that wait past the turn (ADR 0076). `questions.wait(sessionId, { origin, owner, for, timeoutMs })` makes the `ask_user` questions of a Session the plugin started end the turn instead of holding it open. Each waits in Needs you, and where `origin` (the event the work came from) says, until it is answered or times out, and its answer comes to the Session as a message that names the question. `questions.open(sessionId)` lists the open ones, and `questions.answer(id, { text, by })` answers one. `questions.ask(sessionId, { questions, defaults, for })` asks from the server in such a Session, as the Routines plugin asks for an approval. The Ask plugin publishes `ask.answered` when a question is answered or times out. `provide.replies({ post })` is how a plugin that publishes events posts a question back where one of them came from, such as a comment on the issue. It answers false when it can't, and later hands the replies people write there to `questions.answer`. One plugin per server keeps the questions with `provide.questions`, which the Ask plugin does.
- `urls.public(path)` is a route's address from outside, and `urls.browser` ties an OAuth state to the browser that started it.
- `clock`, `env`, `log` and `signal`, which aborts when the server stops.

## The web part

```tsx
import { defineWeb, useApi } from "@pipoca/plugins/web";
import { Button, Page } from "@pipoca/ui";
import { useState } from "react";
import { greeter } from "../plugin";

function Greeter() {
  const api = useApi(greeter);
  const [greeting, setGreeting] = useState("");

  const greet = async () => {
    const body = await api.get<{ greeting: string }>("greeting");

    setGreeting(body.greeting);
  };

  return (
    <Page title="Greeter" description="An example plugin." className="gap-4">
      <Button onClick={() => void greet()}>Greet me</Button>
      <p>{greeting}</p>
    </Page>
  );
}

export const web = defineWeb(greeter, {
  pages: [{ path: "", label: "Greeter", Page: Greeter, nav: {} }],
  settings: { group: "server", form: "auto" },
});
```

- `pages` are the plugin's pages, under `#plugin/<id>/<path>`. `nav` puts one in the sidebar, and `area` puts it on the team hub or in Team setup instead. `href(plugin, path)` links to one.
- `settings` is its section on the Settings page: `form: "auto"` draws a form from its config, or give your own `Section`.
- A page or `Section` puts its title, description and actions in `Page` from `@pipoca/ui`. Inside the app's own column it draws only those and its content.
- `setup` adds at most one step to the server's setup, which an admin does once, and one to each person's ([ADR 0072](adr/0072-server-setup-and-personal-setup.md)). Each has `audience: "server"` or `"person"`, `done(api)` and a `Step` component, and `after` names the kernel step it follows: `who`, `plugins`, `default-profile`, `where` or `newcomers` in the server's setup (after `plugins` when left out), and `welcome`, `where` or `profile` in a person's (after `welcome`). Steps after the same kernel step go in the order the plugins load. To go right after another plugin's step, `after` is `{ plugin, or }`, such as `{ plugin: "oidc", or: "plugins" }` for code hosts after sign-in: when that plugin's step isn't shown, or itself goes after another plugin's, the step goes after the kernel step `or`. `Step` gets `{ solo }`: on a server just for its person, a plugin with both steps shows only its personal one, with `solo` true, so it sets up both on one screen. A server step with `teamOnly: true`, such as sign-in or a Slack bot, is left out there too. A personal step with `optional: true` can be skipped, unless an admin made it required for new people; one that isn't done stays on home as a reminder.
- `slots` fills places the app draws in: `session.composer`, `session.header`, `session.files` (files added in the composer that aren't images, until the message is sent), `session.toolCall:<tool>`, `notice:<kind>`, `link:<scheme>`, `home`, `environment.section`, `template.section` and `settings.general`, `settings.accounts` and `settings.profile`. A `session.header` part can draw a `SessionTab` (`name`, `order`, `label`, `button`, `icon`, its contents as children): a button in the header that opens its contents as a tab of the one panel beside the Session, next to other plugins' tabs.
- `panels` are panels admins lay out on the team hub, `sessionPath` is where a Session the plugin owns opens, and `repositories` adds to what New Session offers.

`useApi(plugin)` calls the plugin's routes: `get`, `post`, `put`, `patch` and `delete` take JSON and return it, and `raw` returns the `Response`. A path that starts with `/`, such as `/api/environments`, goes to the server's own API. `useLoaded(load, key, { topics, changes, everyMs })` loads data, and loads it again when a kernel topic such as `sessions` or `environments` changes, when one of the plugin's own `changes` does, or every `everyMs` for data that changes outside Pipoca. `useViewer()` says who is looking. `useDraft()(sessionId, text)` puts text in a Session's composer and opens it, for the person to send or not.

The part shares `react`, `react-dom`, `@pipoca/ui` and `@pipoca/plugins/web` with the page, so hooks work and it looks like the rest of the app. It can't import CSS or other files. The page only has the Tailwind classes the app itself uses, so build the UI from `@pipoca/ui` components.

## The Session part

```ts
import { defineSession } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const session = defineSession(greeter, (s) => {
  s.extension((pi) => {
    pi.registerCommand("greet", {
      description: "Say the greeting from the Greeter plugin's config",
      handler: async (_args, ctx) => {
        const { greeting } = await s.api.get<{ greeting: string }>("greeting");

        ctx.ui.notify(`${greeting} from ${ctx.cwd}`, "info");
      },
    });
  });
});
```

The Session part runs in every Session's process, on whichever machine runs it, including a laptop. `s.extension` adds a Pi extension (Pi's `docs/extensions.md`), and `s.tools.define` adds a tool. `s.api` calls the plugin's routes as the Session, which reach routes with `auth: "session"`. `s.blobs` uploads files to the plugin's blob store and says which hashes the server lacks. `s.config` is its config as it was when the Session started, without secrets. `s.publish(key, data)` shares a value with everyone watching the Session, `s.checkouts` lists the git checkouts in its workspace, `s.folder` is a folder of the plugin's own for the Session outside its workspace, which Pi's tools reach too, `s.askQuestions` and `s.askPermission` ask the person, and `s.log` logs. Runners fetch the bundle by its hash when a Session starts.

Team Sessions load a plugin's tools and its Session and web parts while an admin leaves it on in Team setup's Plugins in team work. Built-in plugins start on there, installed ones off (ADR 0067).

## Install it

There are three ways to put a plugin on a server, and each one installs it turned off:

- **From git:** paste the repository's URL on the Plugins page. A branch, tag or commit after `#` pins it, for example `https://github.com/you/greeter.git#v1.0.0`. The plugin's `package.json` has to be at the top of the repository.
- **From a tarball:** paste a `.tgz` URL. It must hold one folder, as `npm pack` makes.
- **In place:** ask the Pipoca assistant to write one. It writes the files into the plugins folder and builds them, but it can't turn the plugin on.

You can also put the folder in the server's plugins folder yourself (`--plugins`, next to the database by default), or link it there from where you develop it.

Then select Turn on. The confirm lists where its parts will run. Restart the server from the banner that appears. A plugin installed from git or a tarball can be updated to the newest version at its URL. A new version that adds a part is turned off until you turn it on again. An installed plugin can't sign people in.

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

## Know the limits

- A plugin runs with the server's own access. Nothing sandboxes it, so turn on only plugins you trust.
- The server installs dependencies with `bun install --ignore-scripts` and builds with Bun macros off. A plugin can't use `workspaces`, `patchedDependencies`, `workspace:` or `link:` dependencies, a dependency from a path outside its folder, a `bunfig.toml`, or an `.npmrc`.
- A fetched plugin can't contain symlinks, and a URL can't contain credentials. Use an ssh URL with a key for a private repository.
- `@pipoca/plugins` isn't on npm yet. A running part gets it from the server, but its types and `@pipoca/testing` come from a checkout of the Pipoca repository.
- Parts run from `.build` in the plugin's folder, so a part that reads files next to itself through `import.meta.url` should look one folder up.
