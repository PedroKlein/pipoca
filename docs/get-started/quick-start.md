---
title: Quick start
description: Install Pipoca, run it on your laptop and start a first Session.
sidebar:
  order: 2
---

This gets Pipoca running on your own laptop, for you alone, and starts a first Session. It takes a few minutes. You need macOS or Linux and an account with a model provider Pi supports, such as a subscription you sign in to or an API key.

## 1. Install it

With [Homebrew](https://brew.sh) on macOS or Linux:

```sh
brew install pedroklein/pipoca/pipoca
```

Or take the binary for your system from a [release](https://github.com/PedroKlein/pipoca/releases). Each release also has the [desktop app](../run/desktop-and-phone.md), which does what this page does without a terminal. To build from source instead, see [Contributing](https://github.com/PedroKlein/pipoca/blob/main/CONTRIBUTING.md).

`pipoca --help` lists the commands, and `pipoca <command> --help` explains one.

## 2. Start it in the folder with your code

```sh
cd ~/code && pipoca up
```

`pipoca up` starts a server just for you and opens your browser signed in. Sessions can work in the folder you ran it in and in any folder inside it. Pass `--folder <path>` once or more to share other folders instead.

There is no runner to start by hand: the server starts one on this machine when a Session needs it and stops it after five idle minutes. Run `pipoca up` again later to open it again, or `pipoca link` to print a one-time sign-in link, say for another browser.

## 3. Go through setup

The first time, a short setup asks which plugins to keep on, what your default Profile starts from (your own `~/.pi/agent`, a git repository, or Pi's defaults) and which models you use. In **Your models**, sign in to a provider with your account or paste its key.

You can change every answer later in Settings. A step you skip comes back as a reminder on the home screen.

## 4. Start a Session

Open **New session**, type what Pi should do, pick a checkout in the folder chip and press Enter. Pi works in its own Git worktree on a branch named `pipoca/…`, so your checkout stays as it is.

- Enter while Pi works queues your message for when it finishes its turn. Ctrl+Enter (⌘Enter on a Mac) sends it now.
- **Changes** in the header shows the diff, where you can comment on lines and open a pull request.
- The **Pi** tab shows Pi's own terminal UI for the same Session, and **Terminal** opens a shell in its folder.

Close the tab whenever you like. The Session keeps working, and the browser can tell you when it finishes: turn on notifications in Settings > Notifications.

If you skipped the models step, type `/login` in the Session to sign in to a provider. The login is kept on the server, so every later Session uses it.

## Next

- Keep it running at every login with `pipoca service install up`. See [On your laptop](../run/solo.md).
- Run the server on an always-on VM and keep your laptop as a runner. See [On a VM](../run/vm.md).
- Bring your Pi setup along as a [Profile](../use/profiles.md).
- Learn the words in [Concepts](concepts.md).
