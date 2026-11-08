---
title: Upgrading
description: Move a server to a new version, and what to do coming from before the rebuild.
sidebar:
  order: 7
---

At start the server brings the database up to date in place, so data survives an upgrade ([ADR 0070](../adr/0070-schema-migrations.md)). It refuses a database a newer Pipoca made, such as after going back to an older image: run the newer version again, or restore a backup taken before the upgrade. A plugin whose tables can't be upgraded shows as failed on the Plugins page, with its data kept until an admin resets it.

Pipoca is young, and versions can still break things. Read the [release notes](https://github.com/PedroKlein/pipoca/releases) before you upgrade, and back up the database, its key and the config folder first.

## How

- **Homebrew**: `brew upgrade pipoca`, then start `pipoca up` again, or restart the service.
- **The desktop app** offers each new release itself. See [The desktop app](../run/desktop-and-phone.md#updates-and-logs).
- **A VM**: put the new binary next to the old one and move it into place, then restart the service. See [On a VM](../run/vm.md#update-it).
- **Kubernetes**: `helm upgrade` with a new `image.tag`. The server replaces runner pods that run an older binary by itself ([Runner pods](environments.md#runner-pods)).

Update `pipoca` on the machines that run agents too. Running Sessions are interrupted by the restart and reload from their transcript; a tool that was running is recorded as interrupted by a restart.

## Upgrading from before the rebuild

The rebuild ([ADR 0068](../adr/0068-clean-rebuild.md)) changed the database, the plugin SDK and the HTTP API with no way back and no migration. A server started on a database that older code made stops with `this database was made by another Pipoca version; move it aside to start fresh`.

1. Stop the server. Move `server.db`, and any `server.db-wal` and `server.db-shm` beside it, into another folder. In Kubernetes the database is `/data/server.db` on the data volume: move it with `kubectl exec deploy/pipoca -- …` before the `helm upgrade`, since the new server won't start while it is there.
2. Keep `server.db.key`, or `PIPOCA_SECRET_KEY` and the chart's Secret, and the config folder. Secrets sealed in `pipoca.json` need the same key. One the server can't open is reported with its field; save it again in Settings.
3. Start the new server and open the setup link it logs to create the first user again. `pipoca up` signs you in as before.
4. Update the callback URLs registered outside Pipoca, below.

What starts over: people and their sign-ins, Sessions and transcripts, Environments with their keys, secrets and runners, logins, access tokens, Projects, git host connections and every plugin's data. Make each Environment again and start its agents with the new key. Plugin settings saved before the rebuild were in the database: set them again, including each template's Kubernetes runner pods. Installed plugins start turned off, since `plugins/enabled.json` is no longer read, and should be ported to the plugin SDK v2 ([ADR 0069](../adr/0069-plugin-sdk-v2.md)).

What stays: `pipoca.json` and the config folder, with Profiles, the base Profile, templates and routines. A key that no longer fits is logged and takes its default; an OIDC provider's `clientSecretEnv` is now `"clientSecret": { "env": "NAME" }`. People get new ids, so Profiles, My defaults and routines that belonged to someone point at their old id. To give them back, set `owner` in each Profile's `profile.json` to the person's new id (`GET /api/people` lists them), and rename `people/<old id>/` and `routines/<old id>/` in the config folder.

Plugin routes moved from `/api/plugins/<id>/` to `/api/ext/<id>/`, and nothing answers the old paths. Change each registration, on every host people use, including a port-forward URL:

| Where                                                      | Old                                        | New                                    |
| ---------------------------------------------------------- | ------------------------------------------ | -------------------------------------- |
| OIDC provider, such as IAS: the application's redirect URI | `<url>/api/plugins/oidc/callback`          | `<url>/api/ext/oidc/callback`          |
| GitHub or GitHub Enterprise OAuth app: callback URL        | `<url>/api/plugins/git-hosts/callback`     | `<url>/api/ext/git-hosts/callback`     |
| GitHub App made from the manifest: webhook URL             | `<url>/api/plugins/git-hosts/hooks/<hook>` | `<url>/api/ext/git-hosts/hooks/<hook>` |
| Routine webhooks called from outside                       | `<url>/api/plugins/routines/hooks/<id>`    | `<url>/api/ext/routines/hooks/<id>`    |
| MCP server OAuth client registered with Pipoca's callback  | `<url>/api/plugins/logins/callback`        | `<url>/api/ext/logins/callback`        |

A routine's webhook also gets a new id and secret, since hooks live in the database: copy both from the routine's page. The `oidc` plugin now builds its redirect URI from the server's `--url` (the chart's public host), not from the host the browser used, so a port-forward signs in only when its URL is the server's. The Kyma chart's APIRule already lets `/api/ext` through, so the gateway needs no change.
