---
title: "Tutorial: a plugin with all three parts"
description: Build the Greeter plugin, with a route, a page and a Session command, and run it on your own server.
sidebar:
  order: 2
  label: Tutorial
---

This builds the Greeter plugin from [`examples/plugins/greeter`](../../examples/plugins/greeter): a setting for a greeting, a route that returns it, a page in the sidebar that shows it, and a `/greet` command in every Session. It takes about fifteen minutes. You need a Pipoca server you're an admin of, such as one from `pipoca up`, and a checkout of the [Pipoca repository](https://github.com/PedroKlein/pipoca) for the SDK's types.

## 1. Make the folder

Make a folder named `greeter` with a `package.json`:

```json
{
  "name": "pipoca-greeter",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Greets you on its own page and with /greet in a Session.",
  "pipoca": {
    "id": "greeter",
    "entry": "plugin.ts"
  }
}
```

The `pipoca` field makes it a plugin: its id is `greeter`, and `plugin.ts` defines it.

## 2. Define it

`plugin.ts` names the plugin and declares its config, a greeting with a default:

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

The config becomes the `greeter` key of the server's `pipoca.json`, and the Plugins page draws a form for it.

## 3. Answer a route

`src/server.ts` runs in the server's process. It answers `GET /api/ext/greeter/greeting` for anyone signed in:

```ts
import { defineServer } from "@pipoca/plugins";
import { greeter } from "../plugin";

export const server = defineServer(greeter, ({ config, routes }) => {
  routes.get("greeting", { auth: "person" }, () => ({
    greeting: config.get().greeting,
  }));
});
```

`config.get()` reads the current value, so a change on the Plugins page shows up on the next request.

## 4. Add a page

`web/index.tsx` runs in the browser. It adds a page to the sidebar that calls the route, and a section in Settings with a form drawn from the config:

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

Build the UI from `@pipoca/ui` components, so it looks like the rest of the app.

## 5. Add a command to Sessions

`src/session.ts` runs in every Session's process, on whichever machine runs it. It adds a Pi extension with a `/greet` command that calls the same route as the Session:

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

## 6. Install it and turn it on

Put the folder in your server's plugins folder, next to the database (`~/.pipoca/plugins/greeter` for `pipoca up`), or link it there from where you develop it. You could also push it to a git repository and paste its URL on the Plugins page.

Open Settings > Plugins. Greeter is listed, turned off. Select **Turn on**: the confirm lists where its parts will run. Then **Restart now**, or restart the server yourself. The server installs and bundles the plugin as it starts, and shows any build error on the Plugins page.

## 7. Try it

- **Greeter** is in the sidebar, under **More** until you pin it there. **Greet me** shows "Hello".
- Change the greeting in Greeter's section of Settings, and **Greet me** shows the new one.
- Start a new Session and type `/greet`. Pi shows the greeting and the Session's folder.

## Next

- Give it tables, schedules or tools: [The server part](server.md).
- Fill places in the app, such as the Session header: [The web part](web.md).
- Test it: [Testing and installing](testing-and-installing.md).
