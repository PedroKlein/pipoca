# 0055: The Desktop App

- Status: accepted
- Date: 2026-11-02

## Context

[ADR 0053](0053-ways-to-run-pipoca.md#no-desktop-app-yet) left out a desktop app: `pipoca up`, `pipoca connect`, `pipoca service install` and the installable web UI covered what one would do. Those are built now.

They still assume a terminal. Someone who wants Pipoca running on their own machine has to install a binary, run it from a shell and keep it running. An app they download and open is easier for them, and it can do things a browser tab can't: a tray icon, starting at login, a folder picker that returns real paths, native notifications. Plugins could use those too.

Claude Code is the model. Its desktop app picks where a session runs (local, SSH or cloud) and installs itself on an SSH host when it isn't there. Its phone app is a client for sessions running elsewhere and never runs code ([Claude Code on mobile](https://code.claude.com/docs/en/mobile)).

Four shells were compared: the installable web UI alone, Tauri, Electrobun and Electron.

- Electron bundles Chromium and exposes the DevTools Protocol for any page in the window, so an agent can drive a browser pane inside it. It costs the largest download, a Node runtime next to the Bun one in the binary, and following Chromium security releases.
- Electrobun's main process is Bun, the closest fit. It has one maintainer who doesn't promise to review issues or pull requests, and its Bun version may not match the one Pi needs ([README](https://github.com/blackboardsh/electrobun)).
- Tauri uses the system webview, has a mature updater, signing and per-origin permissions, and its shell is a small Rust program. On macOS its webview is WebKit, which has no DevTools Protocol.

## Decision

### A Tauri app around the binary

- Pipoca gets a desktop app built with Tauri (decided 2026-11-02). It is built now that ADR 0053 has landed, macOS first, then Linux. Windows stays out, as in ADR 0053.
- The app bundles the `pipoca` binary and runs it as a separate process. The server never runs inside the app's process, so a crash in the window doesn't stop Sessions, and the app and the command line run the same code.
- The app never carries its own copy of the web UI. Its window loads the UI from the server it is connected to, so an app and a team server on a different version can't disagree about the UI, and the app is updated only for the shell and the bundled binary.

### Connections

The app keeps a list of connections, like Claude Code's environment picker:

- **This Mac** runs `pipoca up` and signs the window in with a one-time link. It is the batteries-included install: open the app and start a Session.
- **SSH** runs `pipoca connect user@host`. When the host has no `pipoca`, the app copies its own binary there, as Claude Code does.
- **Server URL** opens a team server. Nothing runs locally unless the person also joins this machine to it as a runner, which is left for later.

The app shows each connection's server and runner state in its tray icon and starts the chosen ones at login, which replaces `service install` for app users.

### Signing in to a team server

- Some identity providers refuse to sign in inside an embedded webview, so the app signs in through the system browser.
- After OIDC, the server can send the browser to a `pipoca://` link that carries a one-time sign-in link, the kind solo installs already use ([ADR 0053](0053-ways-to-run-pipoca.md#solo-installs)). The app follows it in its window and gets its own session cookie, kept in the operating system's keychain.

### What the app gives plugins

- The app offers a few native features to web parts: notifications, a folder picker that returns the path the person chose, revealing a path in Finder, tray items and deep links.
- A web part checks whether a feature is there before using it. A contribution that needs one is hidden in a plain browser, so every plugin keeps working on the web.
- The window loads its UI from a server, so these features are code that a server and its plugins run on the person's machine. They stay small, none of them reads files or starts processes (the local runner already does that), and Tauri's permissions grant them per server: a This Mac connection gets them, and a remote server gets each one only after the person allows it once.

### The integrated browser

- The browser stays its own decision ([ADR 0022](0022-plugin-model-v2.md#no-browser-plugin-yet)). In this app it can be a native webview the agent drives through injected scripts and native snapshots, which works for any site but can't send trusted input events. Driving a pane through the DevTools Protocol would need Electron or a Chromium runtime for Tauri, and is chosen when the browser is built.
- Like Claude Code's browser pane, which isn't available in SSH sessions, an in-app browser only helps Sessions running on the app's own machine.

### Phones

- Phones keep the installable web UI. The server gets Web Push with its own key, which reaches installed web apps, including on iOS, for "needs you" and "finished".
- There is no store app. Native push needs Apple and Google keys that a self-hosted server can't ship, so it would need a relay that someone hosts.
- A solo or SSH server has no public address. A phone reaches it through the person's own private network, such as Tailscale, which the docs describe. Pipoca doesn't open a public tunnel by itself.

### Releases

- Builds are published as GitHub Releases and updated with Tauri's updater from a signed manifest there. Only the updater manifest is signed.
- macOS builds aren't signed with an Apple Developer ID or notarized for now (decided 2026-11-02), so macOS warns the first time the app opens and the guide says how to open it anyway. Signing can come later without changing the app.
- The CLI binary stays a release asset of its own for servers and people who prefer the terminal.

## Consequences

- A new user on macOS can download one app and run Sessions on their own machine without a terminal.
- Pipoca needs a macOS CI runner for releases and an updater signing key kept as a repository secret. An Apple Developer account comes only with signed builds.
- The repository gains a small Rust program and its toolchain in CI.
- The web UI has to keep working in Safari's engine, as the installable web UI already requires.
- Plugins can use native features only through feature checks, and a remote server's plugins only with the person's consent.
- The order is: Web Push, the macOS app with This Mac and SSH connections, copying the binary to an SSH host, Server URL connections with the `pipoca://` sign-in handoff, then Linux builds. The handoff is built with Server URL connections because nothing else uses it.
