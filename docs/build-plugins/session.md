---
title: The Session part
description: Pi extensions, tools and commands a plugin adds to every Session.
sidebar:
  order: 5
---

`src/session.ts` exports `session`, made with `defineSession`. It runs in every Session's process, on whichever machine runs it, including a laptop:

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

## What it gets

- `s.extension` adds a Pi extension, with everything Pi's extension API offers (Pi's `docs/extensions.md`, which every Session has in its docs folder).
- `s.tools.define` adds a tool.
- `s.api` calls the plugin's routes as the Session, which reach routes with `auth: "session"`.
- `s.blobs` uploads files to the plugin's blob store and says which hashes the server lacks.
- `s.config` is its config as it was when the Session started, without secrets.
- `s.publish(key, data)` shares a value with everyone watching the Session.
- `s.checkouts` lists the git checkouts in its workspace.
- `s.folder` is a folder of the plugin's own for the Session, outside its workspace, which Pi's tools reach too.
- `s.askQuestions` and `s.askPermission` ask the person.
- `s.log` logs.

Runners fetch the bundle by its hash when a Session starts, so a new version reaches every runner without installing anything there.

## In team Sessions

Team Sessions load a plugin's tools and its Session and web parts while an admin leaves it on in Team setup's **Plugins in team work** ([ADR 0067](../adr/0067-team-plugins-projects-and-assistant.md)). In a team Session, the part sees each message's author and target, and off-the-record messages never reach it. A team plugin's Session part that needs a model or MCP login gets a proxy token, never the key.
