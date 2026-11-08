---
title: HTTP API
description: How the server's API is laid out, its conventions and its errors.
sidebar:
  order: 3
---

The web app, runners and the toolsets all use the same HTTP API. One route table, [`packages/protocol/src/routes.ts`](../../packages/protocol/src/routes.ts), lists every kernel route with its method, path, who may call it and its TypeBox schemas, and the clients call routes by name through the client made from it. Read it for the exact shapes.

## Prefixes

| Prefix          | For                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/api`          | People, through the web app or a script with their sign-in cookie.                                                     |
| `/api/ext/<id>` | Each plugin's own routes ([The server part](../build-plugins/server.md#routes)).                                       |
| `/api/mcp`      | MCP clients, with an access token as `Authorization: Bearer pcm_…` ([The assistant](../use/assistant.md#mcp-clients)). |
| `/runner`       | Runners and the Sessions they host, with their own tokens.                                                             |
| `/healthz`      | Public: the running version and the Pi version it bundles, or a 503 when the database can't be read.                   |

A route says who may call it: a signed-in person, an admin, a runner, a Session, or anyone.

## Conventions

- State changes with `PATCH`, such as `PATCH /api/sessions/<id>` with `{ "archived": true }`.
- Creates answer with what they made, and lists with an array.
- An error answers with `{ "error": code, "message": message }`, and a body that doesn't fit with 422 and the `field` it means ([ADR 0047](../adr/0047-api-errors-and-removal.md)).
- Admins can list everyone's Environments and Sessions with `?scope=all` on `/api/environments` and `/api/sessions`, and people with `GET /api/people`, as an outline, without variable values, folders or what a Session was first asked.

## Examples

Fork a Session: `POST /api/sessions` with `"from": { "session": "<id>" }`. `from.entry` is optional: the id of a user message in the transcript. It answers with the new Session and the message's text as `editorText`. Without `entry` it copies the whole transcript. With an `environment` it forks into another Environment.

Set an Environment's setup: `PATCH /api/environments/<id>` with `setupScript`, `variables` and `secrets`; a null secret removes it. The API lists secret names only.

Make an Environment from a template: `POST /api/environments` with `"template": "<id>"`.

Delete an Environment once all its Sessions are archived: `DELETE /api/environments/<id>`. That revokes its key and its runners' tokens and removes its archived Sessions.

Set a template's runner pods, as an admin:

```sh
curl https://pipoca.example.com/api/ext/kubernetes/templates/<template id> \
  -H 'content-type: application/json' --cookie <session cookie> \
  -d '{"settings": {"workspace": "pod", "capacity": 1, "maxPods": 5, "idleSeconds": 300, "podPatch": {}}}'
```

`{"settings": null}` turns them off again.

## Stability

The API changes with Pipoca, and the rebuild changed it with no way back ([ADR 0068](../adr/0068-clean-rebuild.md)). Script against it knowing that, and prefer [MCP](../use/assistant.md#mcp-clients) for tools that should keep working.
