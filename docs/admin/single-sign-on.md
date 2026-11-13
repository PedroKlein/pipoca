---
title: Single sign-on
description: Sign people in through OpenID Connect providers such as SAP IAS, Okta or Google.
sidebar:
  order: 7
---

The `oidc` plugin signs people in through any OpenID Connect provider you add, and lets in the groups or emails you choose ([ADR 0038](../adr/0038-single-sign-on-and-admins.md)). It is on by default on a team server.

## Add a provider

1. Register `<url>/api/ext/oidc/callback` as the redirect URI with the provider, where `<url>` is the server's public address (`--url`, or the chart's `url`). The plugin builds the redirect URI from it, not from the host the browser used, so a port-forward signs in only when its URL is the server's.
2. In Settings > Sign-in, add the provider: its issuer, client ID, a client secret only if the provider requires one (the plugin uses PKCE), and who gets in, by groups from the ID token (`accessGroup`, from the `groupsClaim`) or by verified email and domain (`allowedEmails`, `allowedDomains`).

Each provider gets its own button on the sign-in page.

## Turn passwords off

Link your own user to a provider from Settings first. Then start the server with `--sso-only`, or set the chart's `oidc.ssoOnly=true`, to turn the password login off. It is set when the server starts, so Settings shows it without a switch. The setup link still works, and on a server where only a provider signs people in, the first admin opens the setup link and then signs in through that provider.

## Providers in the config file

Settings keeps the providers in `pipoca.json`, under `oidc.providers`, and you can edit that file by hand too. To come up with providers already set, put them under the chart's `config` value, each with an `id`:

```yaml
config:
  oidc:
    providers:
      - id: ias
        label: Sign in with SAP
        issuer: https://<tenant>.accounts.ondemand.com
        clientId: <client id>
        accessGroup: pipoca-users
        adminGroup: pipoca-admins
```

The chart writes `config` to the data volume only when no `pipoca.json` is there yet, so after that edit the file or use Settings. To keep sign-in in the chart instead, put it under `lockedConfig`: the chart mounts it read-only at `/etc/pipoca/pipoca.json` and starts the server with `--locked-config`, its keys win over the same keys in the data volume's file, and Settings shows them without letting anyone change them.

A provider that needs a client secret either gets it in Settings, which stores it sealed, or names an environment variable as `"clientSecret": { "env": "NAME" }`, which the chart's `extraEnv` or `extraEnvFrom` fills from a Kubernetes Secret.

## Admins

`adminGroup`, or `adminEmails`, makes those people admins when they sign in. People and their roles are listed on the People page in Settings.
