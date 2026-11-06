# Pipoca guide

How to run Pipoca and what each part of it does, in more detail than the [README](../README.md). The design behind it is in [architecture.md](architecture.md) and the decision records in [adr/](adr/).

## Run it on your laptop

Install it with Homebrew, `brew install pedroklein/pipoca/pipoca`, take the binary for your system from a [release](https://github.com/PedroKlein/pipoca/releases), or build it from source with [Bun](https://bun.sh). You also need a working Pi setup with at least one model you can log in to. From source:

```sh
bun install
bun run build
cd ~/code && ~/pipoca/apps/pipoca/dist/pipoca up
```

`pipoca up` starts a solo server, one person's install ([ADR 0053](adr/0053-ways-to-run-pipoca.md)), and opens the browser signed in. It makes an Environment named This machine whose runner the server starts when a Session needs one and stops after five idle minutes, so there is no agent to start by hand. Its Sessions work in the folder you ran `up` in, or in the folders you pass with `--folder`. Run `pipoca up` again for a new sign-in link, or `pipoca link` to print one, say for your phone. The link works once, within ten minutes, and only your own system user can get one, through a socket next to the database. Any Environment can run here: its This machine section turns it on, with how many Sessions run at once and which folders they work in. A solo install has no other users, no People page and no setup link; `pipoca server --solo` is the same without opening the browser.

To keep your server on an always-on machine, such as a VM, run `pipoca up` (or `pipoca server --solo`) there and connect from your laptop:

```sh
cd ~/code && pipoca connect me@my-vm
```

`pipoca connect` holds an SSH tunnel from `127.0.0.1:7420` on your laptop to the server's port on the VM, starting `ssh` again whenever it drops, and opens the browser signed in through it. It also runs your laptop as a runner through the tunnel, in an Environment named after it, sharing the folder you ran it in or the ones you pass with `--folder`. It signs in by running `pipoca link` on the VM over SSH, so it needs nothing but your SSH access; pass `--remote-pipoca <path>` when `pipoca` isn't on the PATH a plain `ssh me@my-vm pipoca` gets, `--remote-database` when the server there runs with `--database`, and `--port` and `--local-port` for other ports. The tunnel never shares a `ControlMaster` connection from your SSH config, so `connect` can tell when it drops. A host with no `pipoca` gets one: `connect` downloads the release of its own version for that host's system from GitHub into `~/.pipoca/bin` (set `PIPOCA_RELEASES` to download from a mirror instead), installs `up` there as a service with the `--port` and `--remote-database` you gave, and connects to it. The host needs `curl`.

The web UI installs as an app from the browser's menu ([ADR 0053](adr/0053-ways-to-run-pipoca.md)). Settings > Notifications turns on notifications for one device: the server, through the built-in `push` plugin, tells it when one of your Sessions finishes or Pi needs you, even with Pipoca closed ([ADR 0055](adr/0055-desktop-app.md#phones)). It sends only to the push services browsers use (Google, Mozilla, Apple, Microsoft), with a key it makes on first start, so the server has to reach them. On an iPhone, add Pipoca to the Home Screen and turn it on from there. A phone reaches a solo server through your own private network, such as Tailscale. A browser without push still gets a notification while a Pipoca tab is open, after Notify me in the sidebar.

`pipoca service install up` or `pipoca service install connect me@my-vm`, with the same options, runs either one at every login and again if it fails: a launchd agent on macOS (`~/Library/LaunchAgents/dev.pipoca.plist`, logging to `~/Library/Logs/pipoca.log`) and a systemd user unit elsewhere (`~/.config/systemd/user/pipoca.service`). A service opens no browser, so use `pipoca link --open` to sign in. It keeps the PATH you installed it from, so it finds docker and ssh. `pipoca service uninstall` removes it.

The rest of this section sets up a server that more people sign in to:

```sh
apps/pipoca/dist/pipoca server
```

The first time it starts, the server logs a setup link (`open the setup link to create the first user`). Open it to create your user; the link works once. After that, the page asks for that name and password, and a browser stays signed in for 30 days. Ten wrong passwords for a name from one address lock that name there for 15 minutes, and 50 wrong passwords from one address, for any names, lock that address. A person signing in from somewhere else isn't locked out.

On the Environments page, make an Environment named `laptop`. The page shows its key once, in the command that starts an agent:

```sh
PIPOCA_KEY=pck_… apps/pipoca/dist/pipoca agent --name laptop --folder ~/code/my-project
```

Then open New session, type what Pi should do, pick `~/code/my-project` in the folder chip (and the `laptop` Environment, when there is more than one), and press Enter. The composer remembers what you picked for next time. A session runs in the Environment it was created in ([ADR 0014](adr/0014-concept-map-and-environments.md)).

The agent only runs sessions in the folders you list with `--folder`, or in folders inside them. One `--folder ~/code` covers every checkout under it, and the folder chip lists the git checkouts it finds there, after the ones you used recently. The workspace follows from what you pick ([ADR 0040](adr/0040-fewer-forms.md)). A folder gets its own Git worktree, on a branch named `pipoca/` plus the last 8 characters of the session id, stored under the agent's data directory. Tick "Share the folder" in the chip to run in the folder itself; sessions sharing a folder this way can step on each other's changes. A pasted repository URL gets a fresh clone. Two or more URLs check each one out side by side in one workspace, all on the session's branch: as a worktree of a checkout under a listed folder whose remote is that repository, or as a fresh clone when none is. The Changes panel then shows each repository on its own, and archiving deletes the workspace only if none of them would lose work and no other files sit beside them.

### The desktop app

The app for macOS and Linux in `apps/desktop` ([ADR 0055](adr/0055-desktop-app.md)) does the same without a terminal. Its window lists connections: This Mac (This computer on Linux) runs `pipoca up` with the app's own copy of `pipoca` and signs the window in, an SSH machine runs `pipoca connect` to it, each on its own local port, and a server URL opens a team server. On a team server's sign-in page, "Sign in with your browser" signs in through your browser, with single sign-on or a password, and asks you there to open the app signed in. Closing the window keeps the servers running; the tray icon marks the running ones and quits the app, which stops them. "Start at login" starts a connection when you log in, without opening the window. The servers log to `~/Library/Logs/dev.pipoca.desktop/<connection>.log` (`~/.local/share/dev.pipoca.desktop/logs/` on Linux), and the connections are kept in `~/Library/Application Support/dev.pipoca.desktop/connections.json` (`~/.config/dev.pipoca.desktop/` on Linux). Builds are signed ad hoc but not with an Apple Developer ID yet, so macOS says a downloaded Pipoca is damaged. Clear its quarantine flag once, after installing from the disk image or Homebrew: `xattr -dr com.apple.quarantine /Applications/Pipoca.app`. Updates the app installs itself don't need it. Each release has a disk image for Apple silicon Macs and a `.deb` and AppImage for x64 Linux; on Linux the tray icon needs a desktop with AppIndicator support, and the `.deb` installs the app's copy of `pipoca` as `/usr/bin/pipoca`. On a Mac, `brew install --cask pedroklein/pipoca/pipoca-app` installs the app too; the release workflow updates the formula and cask in [homebrew-pipoca](https://github.com/PedroKlein/homebrew-pipoca) with a token in the `HOMEBREW_TAP_TOKEN` secret, and the cask leaves updates to the app. The app checks the newest release when it starts and every six hours. When there's a newer one, the window and the tray offer it, and "Update and restart" installs it, stops the servers the app started and opens the new version. Updating the `.deb` asks for your password. A release is made by bumping the version in `apps/pipoca/package.json` and pushing a matching `v` tag; the app's version comes from the same file, and the release signs each update with the `TAURI_SIGNING_PRIVATE_KEY` repository secret, whose public key is in `tauri.conf.json`.

To build it, you need Rust as well as Bun: `bun run --cwd apps/desktop build` makes `Pipoca.app` and a disk image on macOS, or a `.deb` and AppImage on Linux (with WebKitGTK 4.1's development files installed), under `apps/desktop/src-tauri/target/release/bundle`, and `bun run --cwd apps/desktop dev` runs it from source.

### In a session

In a session, Enter queues a message for when Pi finishes its turn, and Ctrl+Enter (⌘Enter on a Mac) sends it now, so Pi reads it after its current step. On a phone, Enter starts a new line and the send button sends. A queued message can be taken back or sent now. The header shows the session's token use and cost (the `usage` plugin), and its Diff button opens the Changes panel with what the session changed in its Git workspace (the `changes` plugin). When the agent delegates to subagents (the `subagents` plugin, [ADR 0057](adr/0057-pipocas-own-subagents.md)), each run shows as a card in the chat with its agents, progress and time; open an agent to see its steps and output, and use Steer or Stop while it runs. The header's Subagents button opens every run of the session in a side panel. Subagents run inside the session on its own model and logins, in the background by default, one at a time, in parallel, or as a chain where each step gets the previous one's output, at most 4 at once. The built-in agents are `scout`, `worker`, `reviewer` and `delegate`; a Profile adds its own as Markdown files in `agents/`, and a trusted repository in `.pi/agents/`. `/parallel-review`, `/review-loop`, `/parallel-research` and `/gather-context-and-clarify` are shortcuts that ask the agent to fan out. A run that a restart of the session cut off, such as an upgrade, shows as interrupted, and its card's Resume button carries on with it ([ADR 0058](adr/0058-subagents-v2.md)). A Profile can turn on a watchdog in its Pi `settings.json`, as `{"subagents": {"watchdog": {"enabled": true}}}` with an optional `model` and `thinking`: at the end of each turn that changed the Git working tree, a second model reviews the change with read-only tools, the turn's prompts and any `WATCHDOG.md` from the repository's `.pi/` folder or the Profile. High findings go back to the agent to fix; low and medium ones show in the chat for you only, and a high finding that comes back 3 turns in a row stops being sent until your next message. For flows that are more than one chain or batch, such as a review loop, the agent can write a workflow: a short JavaScript script that starts runs with `runs.run` and `runs.all`, steers them with `runs.steer`, and reads `args`. It runs in a QuickJS sandbox with no files, shell or network, and shows as one card with a row per step. Save workflows as `.js` files in a Profile's `workflows/` folder or a trusted repository's `.pi/workflows/`, and start one with `/workflow <name> [args as JSON]`. A workflow that a restart cut off runs again from the start on Resume, and the steps that had finished give back their output instead of running again. For work toward one objective over many runs, such as a feature that ends in a pull request, the agent can open a mission. The Subagents panel shows each mission with its runs, the links it produced, and the questions it put to you. Answer a question there with one of its options or your own words, and the agent picks your answer up. While a question waits on you, the session shows as needing you, like a thread in a Project. A workflow started for a mission keeps a small JSON `state` there between runs. When the agent works through several steps, it keeps a checklist (the `checklist` plugin, [ADR 0056](adr/0056-session-checklist.md)), pinned above the composer with the step in progress and how many are done; click it to see every step. It goes away once every step is done, and an extension of your own with an `update_checklist` tool replaces it. To come back to something later, such as CI that is still running, the agent schedules a wake-up with `schedule_wakeup` (the `routines` plugin, [ADR 0059](adr/0059-routines-and-wake-ups.md)) instead of sleeping. At that time the session gets the agent's message as a new turn, shown as "Woke up" with its reason. A wake-up is 1 minute to 30 days ahead, a session has at most 10 pending and 48 a day, and archiving the session cancels them. Pending wake-ups are listed above the composer, where you can cancel one. On the Routines page you keep routines: a prompt that runs on a schedule, each time in a new session of its own or as a message to one of your sessions. A routine is a JSON file of yours in the server's config folder, at `routines/<your user id>/<name>.json`, with a `title`, `triggers` (a `cron` expression with a `timeZone`, a single `at` time, an `event` a plugin publishes with an optional `filter` on its fields, or `{ "webhook": true }`), a `run` (a `prompt` with a `workspace` and optionally an `environment`, `profile` and `model`, or a `prompt` and a `session` to message) `overlap` (`skip`, the default, or `queue`) and an optional `key`, the event fields that name what the work is about, such as `["repository", "number"]`. Events with the same key that come within 30 seconds of each other start one run with all of them, or after 5 minutes at most when they keep coming. Once a key has a run, its later events go to that run's session as a message instead of starting another. At most 3 keyed runs go at once, or the routine's `maxRunning`; the others wait as queued and gather their key's events until one ends. The editor lists the events the enabled plugins publish and their fields. A routine with a webhook trigger shows its URL and secret on its page. POST JSON there, signed as `sha256=<HMAC-SHA256 of the body in hex>` in `X-Pipoca-Signature` or `X-Hub-Signature-256` (as GitHub signs its webhooks), and the body arrives as a `routines.webhook` event. The URL must be reachable from the sender, which a laptop install usually isn't. Ask any session to make a routine for you: its `routines` tool restates the routine in plain words and asks you before it creates, changes or deletes one, and a new routine runs once at once as a test. A routine's own runs can't make routines. Edit it on the page or by hand. Each firing is a run with its outcome. The agent ends a run with `end_run` as done, nothing to do or blocked, with a one-line summary shown beside the run ([ADR 0061](adr/0061-software-factory.md#guards)). A run whose turn ends without it shows as stopped, and one can also be failed, skipped or queued. Open a run to see its session. Firings missed while the server was down become one run once it starts, and three runs in a row that failed or couldn't start pause the routine until you resume it. Pi shows Pi's own terminal UI for the session, so extensions that only work in a terminal work there too, and Terminal opens a shell in the session's directory. For a worktree or clone, the "from" chip picks the branch, tag or commit the session's branch starts at. Every session gets the server's docs as files: Pipoca's, Pi's and each installed plugin's, in a folder named by `PIPOCA_DOCS` under the agent's data directory, and Pi is told to read them before writing a Profile, plugin, skill or extension ([ADR 0052](adr/0052-the-assistant-as-a-project.md)).

### The assistant

The home screen and the sidebar's Assistant entry ask the Pipoca assistant (part of the `projects` plugin, [ADR 0035](adr/0035-meta-sessions.md), [ADR 0052](adr/0052-the-assistant-as-a-project.md)). Each person has one assistant, a Project of their own with no repositories that stays out of the Project list; the first question makes it, and every later one goes to the same conversation. Its coordinator runs on the plugin's own Profile, with Pi's `read`, `grep`, `find` and `ls` but no shell or file writes, and does one-shot actions itself. For work you'll iterate on, such as building a Profile or a plugin, it starts a thread with all of Pi's tools in an empty workspace of its own. Before a tool call that asks, such as changing an Environment or installing a plugin, it shows a card with what the call changes and waits for you to allow it, once or for the rest of the Session; other tools run without asking. Its tools manage Sessions, Environments, Profiles and Projects through the same routes as the web UI. A thread builds a Profile or a plugin as a folder in its workspace, then installs it with `install_profile` or `install_plugin`. A new Profile is yours, so installing one doesn't ask; writing into an existing Profile, or installing a plugin, does. Only admins install plugins, and none of a plugin's code runs: it is built, and turning it on stays yours, on the Plugins page. They never see secret values, runner keys or what a Profile's MCP servers hold. When it starts or opens something, a wide screen goes there, a phone shows a notice with an Open button, and the chat keeps a card for it. When the assistant starts fresh, its earlier conversations stay listed behind the Earlier conversations link on the home screen and under the Assistant entry. "Start a session yourself" opens the New session form.

### MCP clients

The same tools are served over MCP at `/api/mcp`, so Pi or Claude Code on your laptop can manage Pipoca too. Make a token under Settings > Access tokens; it is shown once, with the command that adds the server:

```sh
claude mcp add --transport http pipoca https://pipoca.example/api/mcp --header "Authorization: Bearer pcm_..."
```

A client acts as the user who made its token, and asking before risky tools is up to the client. Revoking the token cuts it off at once. The endpoint answers each request with one JSON reply and opens no event stream.

### Projects and the library

Projects (the `projects` plugin, [ADR 0016](adr/0016-projects.md)) group work on one goal. Create one on the Projects page, under the sidebar's Assistant entry, with a name, an Environment, its repository URLs and optional instructions. That starts its coordinator, a session with every repository checked out. Tell the coordinator what you want: it starts a thread session for each piece of work, gets a turn with a short notice after each thread turn, and shares Project memory with the threads. A memory file that exists changes only on top of the revision a session last read, so two writers can't lose each other's change. When Pi compacts the coordinator's context, a fresh coordinator takes over with a handoff in its system prompt: Pi's summary, the latest messages, the threads and the memory index. Start fresh in the Project's settings does the same by hand, and the settings list each earlier conversation ([ADR 0052](adr/0052-the-assistant-as-a-project.md#coordinators-are-swapped-not-compacted)). The Projects page lists the threads with their run and work state and highlights the ones that need you. You can open any thread and talk to it directly. Each Project's library ([ADR 0018](adr/0018-project-library.md)) holds files shared by its Sessions: upload them from the library button on the Project's page, and Project sessions get them with `fetch_file` and add their own with `publish_file`, which asks before it replaces a file of the same name.

### Fork and archive

Fork, in a session's menu, works like Pi's `/fork`. Pick one of your messages, newest first, and a new session starts that remembers the chat up to that message, with the message back in its composer to edit and send. Messages after it and other branches stay behind. "Fork the whole Session" copies the whole chat instead, like Pi's `/clone`. The fork works on its own branch from the forked session's branch.

`POST /api/sessions` with `"from": { "session": "<id>" }` forks it. `from.entry` is optional: the id of a user message in the transcript. It answers with the new session and the message's text as `editorText`. Without `entry` it copies the whole transcript. With an `environment` it forks into another Environment; the new machine gets only what the session pushed. A clone session's fork checks out its branch from the remote, so push that branch first; otherwise the fork fails with "Push the Session's branch first".

Archive hides a session from the list and stops it on its machine; its transcript stays readable under "Show archived", and Unarchive picks it up again. Archiving a worktree or clone session also deletes its workspace if Git says nothing would be lost: no uncommitted or untracked files, and every commit pushed. Otherwise the workspace is kept and the session shows "unpushed work" until you delete it yourself; Delete workspace says why it was kept. A clean workspace comes back from its pushed branch when you unarchive. Files listed in a `.worktreeinclude` at the checkout root, such as `.env`, are copied into new worktrees if Git ignores them.

### Server and agent options

Options:

```text
[PIPOCA_SECRET_KEY=<32 bytes, base64>] \
pipoca up [--port 7420] [--database ~/.pipoca/server.db]
          [--folder <the current folder>]...
pipoca link [--database ~/.pipoca/server.db] [--open | --runner <name>]
pipoca connect <user@host> [--port 7420] [--local-port 7420] [--no-open]
               [--remote-pipoca pipoca] [--remote-database <path>]
               [--name <host name>]
               [--data-dir ~/.pipoca/servers/<host>] [--folder <the current folder>]...
pipoca service install <up or connect, with their options> | uninstall
pipoca server [--supervise] [--host 127.0.0.1] [--port 7420] [--url <public URL>]
                [--database ~/.pipoca/server.db] [--plugins ~/.pipoca/plugins]
                [--trust-proxy] [--solo [--folder <path>]...]
                [--provider <name> [--data-dir ~/.pipoca/server]
                [--folder <path>]... [--extension <path>]...]
PIPOCA_KEY=<Environment key> | PIPOCA_TOKEN=<runner token> \
pipoca agent --name <runner> [--capacity <n>] [--exit-when-idle <seconds>]
               [--server http://127.0.0.1:7420] [--data-dir <see below>]
               [--session-binary <path>] [--folder <path>]...
               [--extension <path>]...
```

`--host` is the address the server listens on; use `0.0.0.0` behind a proxy or in a container. `--url` is where people open it, when that differs, so the setup link points there. `--provider` also runs an agent inside the server, in the Environment of that name, which needs no key. `--trust-proxy` counts failed sign-ins by the client address that the proxy in front adds last to `X-Forwarded-For`. Set it only when every request comes through that proxy: otherwise anyone can send the header and pick their address. Without it, behind a proxy, everyone shares the proxy's address. `--supervise` runs the server as a child process and starts it again each time it restarts, so whatever runs `pipoca` sees no exit for a restart; the container image uses it.

### The config file

The server's config folder, next to the database unless `--config-dir` names another, holds `pipoca.json`: everything people set ahead of time, one source each ([ADR 0039](adr/0039-plugin-config-files.md), [ADR 0068](adr/0068-clean-rebuild.md#storage)). Settings edits it, and so can you; the server reads it again when it changes. The kernel keeps these keys, which no plugin id can take:

```json
{
  "server": {
    "sessionDays": 30,
    "runnerTokenDays": 30,
    "repositorySyncMinutes": 15
  },
  "team": { "name": "Acme", "messagesRead": 40 },
  "plugins": { "slack": { "personal": true, "team": false } },
  "hub": { "pages": [] },
  "newcomers": {},
  "templates": [
    { "id": "pods", "name": "Pods", "kubernetes": { "maxPods": 5 } }
  ]
}
```

`server` sets how long a browser stays signed in, how long a runner token lasts unused, and how often Profiles and templates that follow a repository sync. `team.messagesRead` is how many of the team's messages since its last turn Pi reads. `plugins` turns each plugin on or off (`personal`) and in team work (`team`); a plugin left out keeps its default: built-in plugins on, installed ones off, `local` only on a solo install and `oidc` only on a team server. A template entry holds a key per plugin, such as its pod settings under `kubernetes`, and a template entry that doesn't fit is logged and left out. A plugin's switch or a field of another kernel key that doesn't fit is logged and takes its default, and the rest keep their values. Every other key is a plugin's: its declared settings, which take their default from its manifest when left out, beside its own config. A secret in the file is either `{ "sealed": "…" }`, as Settings saves it, or `{ "env": "NAME" }`, an environment variable the server reads once and then takes out of its environment.

A plugin whose tables another version of it made fails to start and keeps its data. Reset data, next to the reason on the Plugins page, drops its tables, makes them again empty and starts it.

### Plugins

`--plugins` is the folder for installed plugins, next to the database by default ([ADR 0022](adr/0022-plugin-model-v2.md#installing-third-party-plugins)). [docs/plugins.md](plugins.md) shows how to write one. Each is a folder named by its id with a `pipoca` manifest in its `package.json`. Install one on the Plugins page from a git repository or a `.tgz` URL, pinned to its commit or SHA-256 in `.source.json` in its folder, or let the assistant write one in place. Update fetches the newest version from the same URL, and Remove works once the plugin isn't running. An installed plugin starts turned off and none of its code runs. Turning it on asks first, listing the capabilities it asks for and where its parts run, and takes effect when the server next starts. A plugin that is on is installed and bundled into `.build` each time the server starts, using the server's own binary as `bun`, so the machine needs neither Bun nor npm, and a build error shows on the Plugins page. Restart now on that page makes the server exit with code 75 for whatever runs it to start it again: systemd with `Restart=on-failure`, `pipoca server --supervise`, or `bun run dev`. The container image runs the server with `--supervise`, so in Kubernetes it restarts inside its container and the kubelet doesn't count a restart as a crash and back off. It asks first while a Session on the server's own runner is mid-turn, since that turn is interrupted. The server knows systemd by `INVOCATION_ID`; `--supervise` and the dev loop set `PIPOCA_SUPERVISED=1` for the server they start, which you can set for any other supervisor that restarts on exit. Elsewhere it says to restart the server yourself.

### Technical users

Admins register bot identities for work that runs on its own in Settings > Git hosts > Technical users ([ADR 0060](adr/0060-technical-users-and-github-apps.md)). Create a GitHub App sends you to the host with an App manifest, optionally for an organization; once you confirm it there, the host sends you back and the server keeps the App's id, private key and webhook secret, sealed in `pipoca.json` under `git-hosts.technicalUsers`. Then install the App on the accounts it should work in with its Install link; the list shows where it is installed. On a host where Apps can't be made, Add a machine user takes a bot account's personal access token instead. The host only sends an App's events to a server it can reach over HTTPS, so on a laptop install the App gets no webhook. A routine acts as one with `"as": "<name>"` in its `run`: its sessions sign git in as the bot on the bot's host, with a token the server mints for the App's installation on the repository's owner, and commit as the bot. Only the people listed in the technical user's `users` (at first, the admin who added it) can have their routines act as it; for anyone else the session gets no git login. An App created over HTTPS gets a webhook, and its events become routine triggers for the people who may use it: `git-hosts.issue`, `git-hosts.comment`, `git-hosts.pull_request`, `git-hosts.review`, `git-hosts.check` and `git-hosts.push`, each with its `repository`, `number` where there is one, and whether the `author` is a `member` of the repository. Anyone can open an issue on a public repository, so filter on `"member": true` or a label only members can add. A comment's leading `/command` is in `command`, such as `{ "event": "git-hosts.comment", "filter": { "command": "/pipoca", "member": true } }`.

### Slack

The `slack` plugin turns Slack into routine triggers and lets sessions post as a bot ([ADR 0062](adr/0062-slack-and-email.md)). An admin opens Create the Slack app in Settings > Integrations > Slack, which fills in the app's scopes, events and Socket Mode, installs it to the workspace, makes an app-level token with `connections:write`, and adds the bot with its name, bot token and app-level token. The server connects to Slack over Socket Mode, so Slack needs no address of the server, and keeps both tokens sealed in `pipoca.json` under `slack.bots`. The bot's events go to the routines of the admin who added it: `slack.mention`, `slack.message` (in channels the bot is in, or sent to it directly) and `slack.reaction`, each with its `channel`, `user` and `ts`, so a routine can filter on a channel and key on `["channel", "ts"]`. A session of that person gets `slack_post` to post to a channel or reply in a thread, and replies people write in a thread the session posted to come back to that session as messages.

### Email

The `email` plugin turns mail into routine triggers and lets sessions send mail ([ADR 0062](adr/0062-slack-and-email.md)). An admin adds a mailbox in Settings > Integrations > Email with its address, login, IMAP server and SMTP server; the server tries both logins before it saves the mailbox, and keeps the password sealed in `pipoca.json` under `email.mailboxes`. The server checks each mailbox's inbox over IMAP every `pollSeconds` (60 by default, set on the plugin), and the first check only notes where the inbox is, so mail from before doesn't start runs. New mail goes to the routines of the admin who added the mailbox as `email.received`, with its `mailbox`, `from`, `subject`, `messageId`, `inReplyTo` and up to 8000 characters of its plain text, so a routine can filter on a mailbox and key on `["messageId"]`. A session of that person gets `email_send` to send mail or reply to one by its Message-ID, and replies to mail the session sent come back to that session as messages instead of starting runs.

### Keys and tokens

A machine keeps each server's data apart ([ADR 0063](adr/0063-settings-and-first-run-setup.md#one-data-folder-per-server-on-a-machine)). An agent for the machine's own server keeps its Sessions, Profiles and workspaces in `~/.pipoca/agent`, and one for another server in `~/.pipoca/servers/<host>`, as does `pipoca connect` for the host it connects to. A runner that already ran in `~/.pipoca/agent` or `~/.pipoca/connect` for that server stays there, since its worktrees hold absolute paths into it. An agent joins the pool of the Environment whose key it holds, under its `--name`, and gets a token of its own for everything else ([ADR 0033](adr/0033-v2-authentication-and-order.md)). Each session it starts gets a token too, which reaches only that session. Replace key on the Environments page lets go of every agent that joined with the old key; start them again with the new one. The agent reads the key from `PIPOCA_KEY` and removes it from what its sessions inherit. A name belongs to one runner in an Environment ([ADR 0032](adr/0032-environments-and-runners.md)). While a runner of that name is online there, the agent prints `a runner named <name> is online here` and exits with code 1; give it another `--name`, or stop the other one and wait until the Environments page shows it offline, about 30 seconds after its last poll. An agent that joins under the name of an offline runner takes it over, and the old runner's token stops working. The agent keeps its token in `runner.json` in its `--data-dir`, readable only by its user, so a restart against the same `--server` with the same key comes back as the same runner without joining. It joins again when that token is gone or refused. A runner token that no agent has polled with for 30 days stops working, so an agent started with the key just joins again, and one started with `PIPOCA_TOKEN` alone needs a new token. A runner that a plugin starts, such as a Kubernetes pod, gets a token in `PIPOCA_TOKEN` instead, and `--exit-when-idle <seconds>` stops it once it has run no session for that long. Tests of the built binary set `PIPOCA_FAUX_REPLY` so every turn answers with that text and no model provider is needed.

### Environment setup and secrets

An Environment can have a setup script, variables and secrets (`PATCH /api/environments/<id>` with `setupScript`, `variables` and `secrets`; a null secret removes it). Each agent runs the setup script once per version before the first session that needs it, and a session's processes and terminals get the variables and secrets. The API lists secret names only. The server encrypts secrets with AES-GCM before it stores them, using the key in `PIPOCA_SECRET_KEY` (`openssl rand -base64 32`), or else one it makes in `server.db.key` next to the database. Losing the key loses every stored secret. A `GH_TOKEN` secret also signs git in to GitHub over https, both for cloning a session's repositories and for the session's own pushes.

Model provider and MCP server logins belong to each person and live on the server, sealed with the same key ([ADR 0045](adr/0045-server-kept-logins.md)). `/login` and `/mcp login` in any Session save the login there, and every Session that person starts uses it, on any runner, so a Kubernetes pod that exits keeps nothing. Runners read and write a login through the server, which lets one runner at a time refresh it, since providers rotate refresh tokens. An MCP sign-in opens on your device; when the server sends you back to an address on the runner, paste the address your browser lands on. Settings lists your logins under Accounts, where you can log out of one or connect one of Pi's own model providers without a Session: the server runs Pi's sign-in, the sign-in page opens on your device, and for providers that send you to an address on your own machine you paste the address your browser lands on. Providers that extensions add take `/login` in a Session. The same page lists the MCP servers of the base Profile and your Profiles that sign in with OAuth, each with Sign in: the sign-in page sends your browser back to Pipoca at `<url>/api/plugins/logins/callback`, or, for a client registered with a loopback `callbackUrl`, you paste the address you land on. Servers with a `clientSecret` or `clientRegistration: "cimd"` take `/mcp login` in a Session. Logins belong to a Profile layer ([ADR 0063](adr/0063-settings-and-first-run-setup.md#logins-on-profile-layers)). One you add on Accounts or with `/login` goes in your My defaults, so every Profile of yours inherits it. On a Profile's page, Logins switches each provider and MCP server between Inherit and Own login, which signs in with another account just for that Profile and the Profiles that build on it. A Session uses the nearest layer's login: its Profile's, then the Profiles it builds on, then My defaults, then the server base. An admin can add an API key to the server base for everyone, such as a team's service key, but never a subscription sign-in. A Session that refreshes a login from the base keeps its own copy in your My defaults. Accounts shows the layer each login comes from. With the `logins` plugin off, each runner keeps its own logins in its data folder as before.

A repository can share Profiles with a `pipoca.json` at its root that lists them, each a folder of the repository laid out like `~/.pi/agent` ([ADR 0063](adr/0063-settings-and-first-run-setup.md#repositories-carry-a-manifest)):

```json
{
  "profiles": [
    { "name": "Team review", "path": "profiles/review" },
    { "name": "Team docs", "path": "profiles/docs" }
  ]
}
```

Import a Profile from that repository's https or ssh URL on the Profiles page, pick the ones to bring, and each becomes a Profile of yours that follows its folder. The server checks the repository every 15 minutes, and Sync now on the Profile's page checks at once. A synced Profile can't be edited, since the next change in the repository would replace the edit. Make a copy gives you one of your own that stops following it, or make a Profile that builds on the synced one. A repository without `pipoca.json` imports as one Profile from its root folder, as before.

The same file can list Environment templates under `"templates"`, each a JSON file in the repository with the template's `isolation`, `image`, `setupScript`, `variables` and `aliases`, never secrets. The `aliases` are a model alias config like the one on the Models page, and Environments made from the template use them unless an admin gives the Environment its own. On the Environments page, an admin uses From a repository under Templates to bring the ones they pick. They follow the repository the same way and change only there.

### Templates

Admins can share an Environment's settings as a template ([ADR 0049](adr/0049-personal-environments-and-templates.md)): a setup script, isolation, image and variables, but never secrets or runners. Make one under Templates on the Environments page, or list them under `templates` in the config folder's `pipoca.json`, for example from the chart's `config` value:

```json
{
  "templates": [
    {
      "id": "pods",
      "name": "Cluster pods",
      "setupScript": "apt-get install -y ripgrep",
      "variables": { "REGION": "eu" }
    }
  ]
}
```

Anyone can then make an Environment from a template, by picking it next to New Environment or with `"template": "<id>"` in `POST /api/environments`. That Environment is theirs, with their own secrets, variables and runners. Its setup script, isolation and image come from the template, and the template's variables sit under its own. A change to a template reaches each of those Environments when a Session next starts. If a template is deleted, its Environments go back to their own settings.

### Containers

With `isolation: "container"`, each session's Pi process runs in a container from the Environment's `image` (default `node:22-bookworm`; any image with glibc, bash and git works), as the agent's user, with the agent's data directory, its `--folder`s and the workspace mounted at the same paths. The agent needs Docker. It mounts its own Linux binary into the container, so a Linux agent built with `bun run build` needs nothing else. A released agent on a Mac copies the binary of its own version out of the Pipoca image (`ghcr.io/pedroklein/pipoca:v<version>`) into a Docker volume once, as runner pods do. An agent run from source needs `--session-binary <path to a Linux pipoca binary>`. The setup script then runs once in the image as root, and sessions run in the image it leaves. Terminals open a shell in the session's container.

### Runner pools

Several agents can join one Environment's pool with its key ([ADR 0032](adr/0032-environments-and-runners.md)). `--capacity` caps how many sessions the agent runs at once. A session in a folder goes to an agent that lists the folder, and a session that has run goes back to the agent it ran on. A clone or several-repositories session moves to another agent in the pool if its agent stops polling for a minute; it starts again from its transcript in a fresh checkout of its branch, so only pushed work comes along. An agent that can't reach the server for 30 seconds stops those sessions itself, so two agents never run one session.

## Run it in Kubernetes

The `Dockerfile` builds an image that runs the server, and `deploy/helm/pipoca` installs it with one replica and its data on a ReadWriteOnce volume ([ADR 0034](adr/0034-v2-deployment-and-credentials.md)). On install the chart makes a Secret holding the secret key, and it keeps that Secret on upgrades and uninstalls. Put HTTPS in front with your gateway, and set `url` to where people open it. When every request comes through that gateway, `trustProxy=true` counts failed sign-ins by the client address it forwards:

```sh
helm install pipoca deploy/helm/pipoca --set url=https://pi.example.com
kubectl logs deploy/pipoca | grep setup
```

### On Kyma

On Kyma, `apiRule.enabled` puts the server behind Kyma's gateway at `apiRule.host`, and `url` defaults to that host:

```sh
helm install pipoca deploy/helm/pipoca --namespace pipoca --create-namespace \
  --set apiRule.enabled=true --set apiRule.host=pipoca.<cluster domain>
```

The server's API has two prefixes: `/api` for people and `/runner` for runners and the Sessions they host. One route table in `packages/protocol/src/routes.ts` lists every route with its method, path, who may call it and its schemas; the web app, runners and the toolsets call routes by name through the client made from it. State changes with `PATCH`, such as `PATCH /api/sessions/<id>` with `{ "archived": true }`, creates answer with what they made, and lists with an array. An error answers with `{ error, message }`, and a body that doesn't fit with 422 and the `field` it means ([ADR 0047](adr/0047-api-errors-and-removal.md)). Each plugin's own routes sit under `/api/ext/<id>/`.

The gateway lets through only what a browser needs: the web UI, sign-in and the `/api` routes it calls. The setup link, the runner routes under `/runner` and `/api/mcp` stay closed, so open the setup link through `kubectl port-forward svc/pipoca 7420`. Runner pods reach the server through its Service, and the chart adds an Istio policy that lets pods in the namespace reach `/runner`, since the APIRule's own policies only let the gateway in. Sign-ins come only through the gateway, so the chart trusts the client address it forwards. `apiRule.exposeAgents=true` opens `/runner` for runners outside the cluster, such as a laptop, and `apiRule.exposeMcp=true` opens `/api/mcp` for MCP clients.

Previews ([ADR 0037](adr/0037-previews-and-opened-pages.md)) live at `<port>--<session>.<apiRule.host>`, a level deeper than Kyma's own certificate and gateway reach. `apiRule.previews=true` gives them a wildcard certificate from Gardener's certificate service, in `istio-system` where Istio reads it, a gateway that serves it, and an APIRule that sends every path on `*.<apiRule.host>` to the server, which admits a browser to a preview only with a grant it handed out.

### Single sign-on

To sign in through OpenID Connect providers, such as SAP IAS, Okta or Google ([ADR 0038](adr/0038-single-sign-on-and-admins.md)), register `<url>/api/plugins/oidc/callback` as the redirect URI with each provider. An admin adds each provider in Settings > Sign-in: its issuer, client ID, a client secret only if the provider requires one (the plugin uses PKCE), and who gets in, by groups from the ID token or by verified email and domain. Each provider gets its own button on the sign-in page. Link your own user from Settings first, then `oidc.ssoOnly=true` turns the password login off.

Each person sees and uses only their own Environments and Sessions ([ADR 0049](adr/0049-personal-environments-and-templates.md)). An Environment someone makes is theirs, and so is a Session they start. A runner that joins with a join key gets an Environment of the person who made the key. Environments from before belong to the first user, the one the setup link made. Admins see everyone's on the People page in Settings, or with `?scope=all` on `/api/environments` and `/api/sessions` and `GET /api/people`, as an outline, without variable values, folders or what a Session was first asked. Its owner or an admin can delete an Environment once all its Sessions are archived (`DELETE /api/environments/<id>`). That revokes its key and its runners' tokens and removes its archived Sessions. Admins can stop, archive and unarchive anyone's Session, but they can't read its transcript, open its terminal or send it a message. A Project, its threads and its library belong to the person who started it.

Settings keeps the providers in the server's `pipoca.json`, in its config folder next to the database ([ADR 0039](adr/0039-plugin-config-files.md)), and you can edit that file by hand too. To come up with providers already set, put them under the chart's `config` value, each with an `id`. The chart writes `config` to the data volume only when no `pipoca.json` is there yet, so after that edit the file or use Settings. To keep sign-in in the chart instead, put it under `lockedConfig`: the chart mounts that read-only at `/etc/pipoca/pipoca.json` and starts the server with `--locked-config`, its keys win over the same keys in the data volume's file, and Settings shows them as set in the config file without letting anyone change them. A provider that needs a client secret either gets it in Settings, which stores it sealed, or names an environment variable as `"clientSecret": { "env": "NAME" }`, which `extraEnv` or `extraEnvFrom` fills from a Kubernetes Secret:

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

### Images and remote runners

Every push to main publishes the image as `ghcr.io/pedroklein/pipoca:main` and `:sha-<commit>`. Agents on other machines join it with an Environment's key, as above. `builtInRunner` also runs a runner inside the server pod, but only with `runnerPods.enabled=false`: a server that can start runner pods leaves its own off and logs why, since its Sessions would share the server pod's files, sealing key included ([ADR 0049](adr/0049-personal-environments-and-templates.md)).

### Runner pods

The kubernetes plugin can start runner pods for an Environment in the server's namespace ([ADR 0032](adr/0032-environments-and-runners.md)). The chart gives the server a service account that may create and delete pods and Secrets there; set `runnerPods.enabled=false` to leave that out. Pods come from a pod template ([ADR 0049](adr/0049-personal-environments-and-templates.md)): an admin turns on runner pods in a template's Kubernetes section under Templates on the Environments page, or saves its settings:

```sh
curl <server>/api/plugins/kubernetes/templates/<template id> \
  -H 'content-type: application/json' --cookie <session cookie> \
  -d '{"settings": {"workspace": "pod", "capacity": 1, "maxPods": 5, "idleSeconds": 300, "podPatch": {}}}'
```

They are kept in the template's entry in `pipoca.json`, under `kubernetes`. `{"settings": null}` turns them off again. Each person then makes an Environment from that template and gets pods of their own, which never serve anyone else; `maxPods` applies to each Environment. Only an Environment made from a pod template shows a Kubernetes section, read-only.

When some of its Sessions can't go to any runner, the plugin starts one pod for each `capacity` of them, up to `maxPods`. A pod runs the Environment's image, or the Pipoca image when it names none, with the `pipoca` binary copied in. Its agent stops after `idleSeconds` without a Session, and the plugin then deletes the pod and its token. A pod that hasn't started after 10 minutes is deleted too. When a pod fails, or stops without its agent ever reaching the server, the next pod for that Environment waits 10 seconds, twice as long after each failure in a row up to about 5 minutes, and the Environment's Kubernetes section shows why. `podPatch` is a JSON merge patch on the pod, such as `{"spec": {"nodeSelector": {"pool": "agents"}}}`; it can't give the pod a service account token. Only admins change these settings, since a patch can still mount the namespace's Secrets. Pods run Sessions as processes, so the Environment's isolation must be `process`. With `"workspace": "pod"`, the default, a workspace lives only as long as its pod, so use clone or repositories workspaces there. With `"workspace": "claim"`, each Session gets a pod of its own, named after it, whose home is a claim of `claimSize` (with `storageClass`, or the cluster's default). If that pod stops or is deleted, the plugin starts it again with the same claim, and the claim goes once the Session is archived.

After a `helm upgrade`, the server compares the Pipoca image each runner pod copied its binary from with its own, at start and on every pass. It deletes a pod whose image differs, even mid-turn, and the plugin starts a new one, so no pod runs an old binary against the new server. The pod gets a grace period of 30 seconds: its agent stops its Sessions first, waiting up to 10 seconds for each, and a tool cut off is recorded as interrupted by a restart. Once the pod is gone its token is revoked, and a Session with its own claim goes on in the new pod. The server compares the image digests the nodes ran, its own pod's found by the `POD_NAME` the chart sets, so a moving tag such as `main` works too. While a digest isn't known yet, such as for a pod still starting, it compares the image names in the pod specs. A `podPatch` that lowers `terminationGracePeriodSeconds` should leave more than 10 seconds. Pods of an Environment whose settings were removed are left to stop on their own.
