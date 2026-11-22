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

- `pages` are the plugin's pages, under `#plugin/<id>/<path>`. `nav` lists one in the sidebar, under More unless it is `pinned` or the person pins it, and `area` puts it on the team hub (`"hub"`) or in Team setup (`"setup"`) instead. A plugin can list several pages, each pinned on its own. `href(plugin, path)` links to one, and `sessionHref(id)` links to a Session, which opens in the page of the plugin that shows it.
- `nav.Count` draws a number beside the entry, such as what's unread. `nav.Items` lists rows under it, and `nav.Live` lists work below all the entries, such as active Projects.
- A page whose `bare(path)` is true for the rest of the address is drawn alone in the window, without the sidebar, as a link to one artifact is.
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

| Slot                                                                                 | Where                                                                                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.composer`                                                                   | Above a Session's composer, as the checklist is.                                                                                                   |
| `session.panel`                                                                      | A section of the panel beside a Session, drawn with `SessionSection` (below).                                                                      |
| `session.meter`                                                                      | A small readout beside the composer's Send button, as the context ring is.                                                                         |
| `session.files`                                                                      | Files added in the composer that aren't images, until the message is sent.                                                                         |
| `session.attach`                                                                     | A row in the composer's **+** menu, drawn with `AttachRow`, that can open an `AttachPicker` and attach what's picked with `add`.                   |
| `file.actions`                                                                       | Buttons in the file viewer's header for a file of a Session the person steers, such as **Publish**, with the Session, file name and download link. |
| `project.artifacts`                                                                  | The Project's artifacts panel, with every Session of the Project as `sessions`.                                                                    |
| `session.toolCall:<tool>`                                                            | How a call of that tool shows in the chat.                                                                                                         |
| `session.permission:<tool>`                                                          | How a request to run that tool asks for permission.                                                                                                |
| `notice:<kind>`                                                                      | How a notice of that kind shows in the chat.                                                                                                       |
| `codeBlock:<language>`                                                               | How a fenced block of that language shows in the chat, with its text as `code`, and `complete` false while the agent is still writing it.          |
| `link:<scheme>`                                                                      | How a link with that scheme in the chat's Markdown shows.                                                                                          |
| `home`                                                                               | The home screen, drawn by the first plugin that fills it, as the assistant is.                                                                     |
| `overlay`                                                                            | Over every page, as the artifact viewer is. It reads what to show from `useOverlay()`.                                                             |
| `dock`                                                                               | Beside every page, as the artifact viewer is when docked by the chat.                                                                              |
| `activity.channel`                                                                   | Where else a person is told of artifact activity on a `topic`, such as " · push", on the artifacts plugin's Activity page.                         |
| `environment.section`, `template.section`                                            | A section on an Environment's or a template's page.                                                                                                |
| `settings.general`, `settings.accounts`, `settings.profile`, `settings.base-profile` | A section on those Settings pages, or on the Server base.                                                                                          |

`useFilled(slot)` says whether any plugin fills a slot, so a part can leave out a button that would open nothing.

A part adds a part to the panel's **Files** section with `FilesSection` (`name`, `order`, `title`, `count`, an `action` beside the filter, and its rows as a function of the filter): its first rows show in the panel's summary and all of them, filtered, in the section's detail. `FilesRow` is one row. `FileViewer` shows a file over the page in the shared viewer, with the header actions you give it.

The composer's attachments are `Attachment`s (`key`, `title`, `icon`, `detail` and the `text` that goes with the message), drawn as `AttachedCard`s. `FileCard` is the card a file shows as in the chat, which opens it.

A `session.panel` part draws a `SessionSection` (`name`, `order`, `label`, `icon`, `button` for the rail icon's accessible name, an optional short `badge` and `waiting` when it needs the person, an optional `detail`, and its summary as children). Closed, the panel is a rail of every section's icon and badge; open, it lists the summaries, and a section's title or icon opens its detail ([ADR 0084](../adr/0084-session-side-panel.md)). Drawing nothing leaves the plugin out of the panel.

## Team hub and New session

`panels` are panels admins lay out on the team hub. `sessionPath` is where a Session the plugin owns opens, and `repositories` adds to what New session offers.

## Hooks

- `useApi(plugin)` calls the plugin's routes: `get`, `post`, `put`, `patch` and `delete` take JSON and return it, and `raw` returns the `Response`. A path that starts with `/`, such as `/api/environments`, goes to the server's own API.
- `useLoaded(load, key, { topics, changes, everyMs })` loads data, and loads it again when a kernel topic such as `sessions` or `environments` changes, when one of the plugin's own `changes` does, or every `everyMs` for data that changes outside Pipoca.
- `useViewer()` says who is looking.
- `useDraft()(sessionId, text, attachments)` puts text, and attachments if given, in a Session's composer and opens it, for the person to send or not. Empty text keeps what the person typed.
- `useOverlay()` reads and changes what the address shows over the page, after a `?` in its hash: `params`, `open(params, { replace })` and `close()`. Back closes what `open` opened, and the address opens it again.

## What it can import

The part shares `react`, `react-dom`, `@pipoca/ui` and `@pipoca/plugins/web` with the page, so hooks work and it looks like the rest of the app. It can't import CSS or other files. The page only has the Tailwind classes the app itself uses, so build the UI from `@pipoca/ui` components.
