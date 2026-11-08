---
title: The web part
description: Pages, settings, setup steps, slots and hub panels a plugin adds to the web app.
sidebar:
  order: 4
---

`web/index.tsx` exports `web`, made with `defineWeb`. It runs in the browser:

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

## Pages and settings

- `pages` are the plugin's pages, under `#plugin/<id>/<path>`. `nav` lists one in the sidebar, under More unless it is `pinned` or the person pins it, and `area` puts it on the team hub (`"hub"`) or in Team setup (`"setup"`) instead. `href(plugin, path)` links to one.
- `settings` is its section on the Settings page: `form: "auto"` draws a form from its config, or give your own `Section`.
- A page or `Section` puts its title, description and actions in `Page` from `@pipoca/ui`. Inside the app's own column it draws only those and its content.

## Setup steps

`setup` adds at most one step to the server's setup, which an admin does once, and one to each person's ([ADR 0072](../adr/0072-server-setup-and-personal-setup.md)). Each has `audience: "server"` or `"person"`, `done(api)` and a `Step` component.

- `after` names the kernel step it follows: `who`, `plugins`, `default-profile`, `where` or `newcomers` in the server's setup (after `plugins` when left out), and `welcome`, `where` or `profile` in a person's (after `welcome`). Steps after the same kernel step go in the order the plugins load.
- To go right after another plugin's step, `after` is `{ plugin, or }`, such as `{ plugin: "oidc", or: "plugins" }` for code hosts after sign-in: when that plugin's step isn't shown, or itself goes after another plugin's, the step goes after the kernel step `or`.
- `Step` gets `{ solo }`. On a server just for its person, a plugin with both steps shows only its personal one, with `solo` true, so it sets up both on one screen. A server step with `teamOnly: true`, such as sign-in or a Slack bot, is left out there too.
- A personal step with `optional: true` can be skipped, unless an admin made it required for new people. One that isn't done stays on home as a reminder.

## Slots

`slots` fills places the app draws in:

| Slot                                                                                 | Where                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `session.composer`                                                                   | Above a Session's composer, as the checklist is.                               |
| `session.header`                                                                     | A Session's header. It can draw a `SessionTab` (below).                        |
| `session.files`                                                                      | Files added in the composer that aren't images, until the message is sent.     |
| `session.toolCall:<tool>`                                                            | How a call of that tool shows in the chat.                                     |
| `session.permission:<tool>`                                                          | How a request to run that tool asks for permission.                            |
| `notice:<kind>`                                                                      | How a notice of that kind shows in the chat.                                   |
| `link:<scheme>`                                                                      | How a link with that scheme in the chat's Markdown shows.                      |
| `home`                                                                               | The home screen, drawn by the first plugin that fills it, as the assistant is. |
| `environment.section`, `template.section`                                            | A section on an Environment's or a template's page.                            |
| `settings.general`, `settings.accounts`, `settings.profile`, `settings.base-profile` | A section on those Settings pages, or on the Server base.                      |

A `session.header` part can draw a `SessionTab` (`name`, `order`, `label`, `button`, `icon`, its contents as children): a button in the header that opens its contents as a tab of the one panel beside the Session, next to other plugins' tabs.

## Team hub and New session

`panels` are panels admins lay out on the team hub. `sessionPath` is where a Session the plugin owns opens, and `repositories` adds to what New session offers.

## Hooks

- `useApi(plugin)` calls the plugin's routes: `get`, `post`, `put`, `patch` and `delete` take JSON and return it, and `raw` returns the `Response`. A path that starts with `/`, such as `/api/environments`, goes to the server's own API.
- `useLoaded(load, key, { topics, changes, everyMs })` loads data, and loads it again when a kernel topic such as `sessions` or `environments` changes, when one of the plugin's own `changes` does, or every `everyMs` for data that changes outside Pipoca.
- `useViewer()` says who is looking.
- `useDraft()(sessionId, text)` puts text in a Session's composer and opens it, for the person to send or not.

## What it can import

The part shares `react`, `react-dom`, `@pipoca/ui` and `@pipoca/plugins/web` with the page, so hooks work and it looks like the rest of the app. It can't import CSS or other files. The page only has the Tailwind classes the app itself uses, so build the UI from `@pipoca/ui` components.
