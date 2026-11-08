---
title: Pipoca docs
description: Run Pi coding-agent Sessions on your own machines and pick them up from any browser.
---

Pipoca is a self-hosted server for [Pi](https://github.com/earendil-works/pi). You start a Session from the web, it runs on your laptop, a VM or a Kubernetes pod, and it keeps going when you close the tab. These pages say how to run it, how to use it, how to look after a server for a team, and how to write plugins for it.

## Start here

- [What is Pipoca](get-started/what-is-pipoca.md): what it does and what it doesn't.
- [Quick start](get-started/quick-start.md): from install to a first Session in a few minutes.
- [Concepts](get-started/concepts.md): the words Pipoca uses, such as Session, Environment, Profile and runner.

## Pick a way to run it

[Choosing a setup](run/choosing-a-setup.md) compares them. Then follow one:

- [On your laptop](run/solo.md), for yourself.
- [On a VM](run/vm.md), always on, with your laptop as a runner.
- [For a team](run/team.md), with people, team work and shared model keys.
- [In Kubernetes](run/kubernetes.md), with runner pods started on demand, Kyma included.
- [The desktop app and your phone](run/desktop-and-phone.md).

## Use it

[Sessions](use/sessions.md), [Changes and pull requests](use/changes.md), [Projects](use/projects.md), [the assistant](use/assistant.md), [Profiles](use/profiles.md), [subagents](use/subagents.md), [routines](use/routines.md), [artifacts and files](use/artifacts-and-files.md), [team work](use/team.md) and [Slack and email](use/slack-and-email.md).

## Look after a server

[Settings and the config file](admin/settings-and-config.md), [Environments and runners](admin/environments.md), [models and logins](admin/models-and-logins.md), [git hosts](admin/git-hosts.md), [plugins](admin/plugins.md), [single sign-on](admin/single-sign-on.md) and [upgrading](admin/upgrading.md).

## Build plugins

Everything past Pipoca's small kernel is a plugin, the built-in ones included. [Plugins overview](build-plugins/overview.md) explains the model, and the [tutorial](build-plugins/tutorial.md) builds one with all three parts.

## Reference

The [command line](reference/cli.md), the [config file](reference/config.md), the [HTTP API](reference/http-api.md), and the [design and decision records](reference/design.md).
