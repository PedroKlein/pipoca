---
title: Models and logins
description: Model provider and MCP logins kept on the server, shared keys, model aliases, and usage with budgets.
sidebar:
  order: 3
---

## Logins

Model provider and MCP server logins belong to each person and live on the server, sealed with its secret key (the `logins` plugin, [ADR 0045](../adr/0045-server-kept-logins.md)). `/login` and `/mcp login` in any Session save the login there, and every Session that person starts uses it, on any runner, so a Kubernetes pod that exits keeps nothing. Runners read and write a login through the server, which lets one runner at a time refresh it, since providers rotate refresh tokens.

Settings > Accounts lists your logins, where you can log out of one or connect one of Pi's own model providers without a Session: the server runs Pi's sign-in, the sign-in page opens on your device, and for providers that send you to an address on your own machine you paste the address your browser lands on.

- **Providers that a package adds** take a pasted key there, or `/login` in a Session: those of the base Profile as soon as the server has listed them, which it does by itself each time the base changes, and those of other Profiles once your or the team's runners report them.
- **MCP servers** of the base Profile and your Profiles that sign in with OAuth are listed too, each with **Sign in**. The sign-in page sends your browser back to Pipoca at `<url>/api/ext/logins/callback`, or, for a client registered with a loopback `callbackUrl`, you paste the address you land on. Servers with a `clientSecret` or `clientRegistration: "cimd"` take `/mcp login` in a Session.
- Settings reaches an MCP server on a private, loopback or link-local address, such as a Service in the cluster, only when an admin lists its host in the `logins` plugin's `privateHosts`.

With the `logins` plugin off, each runner keeps its own logins in `logins/` in its data folder.

### Logins on Profile layers

Logins belong to a [Profile layer](../use/profiles.md#layers) ([ADR 0063](../adr/0063-settings-and-first-run-setup.md#logins-on-profile-layers)). One you add on Accounts or with `/login` goes in your My defaults, so every Profile of yours inherits it. On a Profile's page, Logins switches each provider and MCP server between **Inherit** and **Own login**, which signs in with another account just for that Profile and the Profiles that build on it, such as a work and a personal account.

A Session uses the nearest layer's login: its Profile's, then the Profiles it builds on, then My defaults, then the server base. A Session that refreshes a login from the base keeps its own copy in your My defaults. Accounts shows the layer each login comes from.

### Shared keys

An admin can add an API key to the server base for everyone, such as a team's service key, but never a subscription sign-in. Server setup's **Shared model keys** step picks them from every provider Pi knows plus the ones the server default Profile adds. To offer a provider Pi doesn't know, add its package to the server default Profile. Each person can still sign in to any provider with their own account or key.

## Team keys, usage and budgets

Team Sessions reach model providers through a proxy on the server ([ADR 0066](../adr/0066-team-credentials-and-usage.md)). The runner gets a token for its Session, never the key. The server checks the token, puts the real key in the header the provider expects and streams the request and the response through unchanged. HTTP MCP servers with team logins go through the same proxy.

Some credentials can't go through it yet: providers that extensions add, whose sign-in code runs where the extension loads, and MCP servers that run as local processes with secrets in their environment. Their keys still reach team runners, and Team setup marks each one as reaching the runner. Personal Sessions keep their logins as above, since those reach only the person's own runner.

The `usage` plugin records each model call through the proxy: the owner, the person who asked, the Session, the model, the credential, tokens in and out, and the cost. Every use of a team credential and every kernel action on team work, such as a stop, an access change or a move to the team, goes in an audit log with its actor.

- **Prices.** Cost is money, worked out from a price per model in dollars per million tokens, which admins set under `usage.prices`, keyed by `provider/model`. A model with no price shows its tokens and no cost.
- **Budgets.** `usage.budgets.team` is the team's monthly budget and `usage.budgets.person` each person's monthly cap of team work, in dollars, 0 for none. Reaching 80% and then 100% warns the person and admins, and the hub shows it. Nothing stops at the limit.
- **Who sees it.** Admins see every row of usage and the audit log, under Budgets and Audit log in Team setup, and can export them. A user sees their own spend and actions, and the team's totals on the hub.

Every Session's header also shows its own token use and cost, personal ones included.

## Model aliases

The `models` plugin gives each Environment model aliases with fallbacks ([ADR 0019](../adr/0019-model-aliases.md)). An alias is an ordered list of `provider/model` refs, which can mix providers, and Sessions pick it as `alias/<name>`. Before every request it goes to the alias's first healthy model that has credentials.

- A transient error, such as a per-minute 429, benches only the model that failed for a minute. A quota or billing cap benches the whole provider until its reset, or an hour. A model the provider doesn't have is skipped for a day.
- An Environment can set a default alias, which a Session with no model uses.
- The Models page edits each Environment's aliases and shows which model each one routes to now and which it skips until when.
- `models.hidden` keeps models out of the model pickers, as `provider/id`.

## The model picker

The composer, New Session, New Project and the assistant share one model picker. It lists one provider at a time beside a rail of providers, with each model's readable name, its id, its context size and whether it reasons. A search covers every provider, and "reasoning" finds the models that reason.

- Each person stars favorites, sees their recent picks, and hides models they never use. The server keeps these per person, so they follow them to every browser.
- A model that failed in a Session of the Environment shows as Unavailable, with the error, for as long as it is benched above. This covers every model, alias or not.
- Team Sessions have no "Log in to a provider…" link, since team work runs on the team's keys.
