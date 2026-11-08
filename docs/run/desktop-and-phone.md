---
title: The desktop app and your phone
description: Run Pipoca from the desktop app, install the web UI as an app, and get notifications.
sidebar:
  order: 6
---

## The desktop app

The app for macOS and Linux ([ADR 0055](../adr/0055-desktop-app.md)) does what `pipoca up` and `pipoca connect` do, without a terminal. Its window lists connections:

- **This Mac** (This computer on Linux) runs `pipoca up` with the app's own copy of `pipoca` and signs the window in.
- **An SSH machine** runs `pipoca connect` to it, each on its own local port. See [On a VM](vm.md).
- **A server URL** opens a team server. On its sign-in page, **Sign in with your browser** signs in through your browser, with single sign-on or a password, and asks you there to open the app signed in.

Closing the window keeps the servers running. The tray icon marks the running ones and quits the app, which stops them. **Start at login** starts a connection when you log in, without opening the window.

### Install it

Each [release](https://github.com/PedroKlein/pipoca/releases) has a disk image for Apple silicon Macs and a `.deb` and AppImage for x64 Linux. On a Mac, Homebrew installs it too:

```sh
brew install --cask pedroklein/pipoca/pipoca-app
```

Builds aren't signed with an Apple Developer ID yet, so macOS says a downloaded Pipoca is damaged. Clear its quarantine flag once, after installing from the disk image or Homebrew:

```sh
xattr -dr com.apple.quarantine /Applications/Pipoca.app
```

Updates the app installs itself don't need it. On Linux the tray icon needs a desktop with AppIndicator support, and the `.deb` installs the app's copy of `pipoca` as `/usr/bin/pipoca`.

### Updates and logs

The app checks for the newest release when it starts and every six hours. When there's a newer one, the window and the tray offer it, and **Update and restart** installs it, stops the servers the app started and opens the new version. Updating the `.deb` asks for your password.

The servers log to `~/Library/Logs/dev.pipoca.desktop/<connection>.log` (`~/.local/share/dev.pipoca.desktop/logs/` on Linux), and the connections are kept in `~/Library/Application Support/dev.pipoca.desktop/connections.json` (`~/.config/dev.pipoca.desktop/` on Linux).

## Install the web UI as an app

The web UI installs as an app from the browser's menu, on a computer or a phone ([ADR 0053](../adr/0053-ways-to-run-pipoca.md)). The whole UI works on a phone, terminal included, with a key bar for the keys a phone keyboard lacks, such as Ctrl and Alt.

A phone reaches a solo server through your own private network, such as Tailscale. Print a sign-in link for it with `pipoca link` on the machine the server runs on.

## Notifications

Settings > Notifications turns on notifications for one device. The server, through the built-in `push` plugin, tells it when one of your Sessions finishes or Pi needs you, even with Pipoca closed ([ADR 0055](../adr/0055-desktop-app.md#phones)).

- On an iPhone, add Pipoca to the Home Screen and turn notifications on from there.
- The server sends only to the push services browsers use (Google, Mozilla, Apple, Microsoft), with a key it makes on first start, so it has to reach them.
- A browser without push still gets a notification while a Pipoca tab is open, after **Notify me** in the sidebar.
