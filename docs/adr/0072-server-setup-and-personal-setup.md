# 0072: Server setup and personal setup, built from plugins

- Status: accepted
- Date: 2026-11-07

## Context

The setup wizard from [ADR 0063](0063-settings-and-first-run-setup.md) mixes what an admin decides for the server with what each person sets for themselves, and it assumes one kind of server. In use it fell short:

- With no hosts in `pipoca.json`, git hosts default to github.com, and the wizard can't add a host or an OAuth app. A team that only uses GitHub Enterprise can't set itself up from the wizard.
- The name and email to commit with are one per person, but they depend on the host: a work address on GitHub Enterprise, a personal one on github.com.
- A provider that a package adds, such as SAP AI Core, can't be offered as a shared key until the package is installed, and the wizard never installs one first.
- "Start clean" in "Make Pi yours" never finishes the step, so it does the same thing as "Skip for now".
- Plugins with something to set up, such as sign-in with OIDC, had no place in the wizard. Some screens named a specific identity provider, which the kernel must never know about.

## Decision

### Two setups

- **Server setup** is done once by an admin. It only sets what the server shares. **Your setup** is done by every person, admins included, after server setup (decided 2026-11-07).
- There are four ways in: just me on my computer (desktop app or `pipoca up`), just me on a VM I host, the admin of a team server, and someone joining a team server. On a solo server one person does both setups, and a step the two share shows once.
- Server setup starts with "Who is this Pipoca for?": Just me or A team. The desktop app picks Just me.
- On a server where only an identity provider signs people in, the first admin opens the setup link and then signs in through that provider.

### Steps come from plugins

- The kernel owns only these steps: Who is it for, Plugins, Server default Profile, Where Sessions run, New people (server setup), and Your default Profile and Ready (your setup).
- Every other step comes from a plugin that is turned on. A plugin can add one server step and one personal step, and says which kernel step it goes before or after. Turning a plugin off removes its steps. A value set by the deploy file shows read-only in its step.
- The Plugins step lists the installed plugins, which ones add a step, and adds new ones from npm or git.
- Kernel screens never name a specific identity provider, git host or model provider. Names come from what the admin entered in a plugin.

Today's plugins add:

| Plugin       | Server step                                                    | Personal step                         |
| ------------ | -------------------------------------------------------------- | ------------------------------------- |
| oidc         | Sign-in: identity providers, passwords on or off, who may join | none                                  |
| git-hosts    | Code hosts                                                     | Connect your code                     |
| logins       | Shared model keys                                              | Your models                           |
| kubernetes   | The pod option in Where Sessions run                           | none                                  |
| slack, email | Their bot or mailbox, when on                                  | Link your account, when they have one |

### Code hosts

- No host is added by default. Any mix of hosts is a normal setup, including only a GitHub Enterprise host.
- People sign in to a host for their own work through one OAuth app per host, which the admin registers for the server. A token stays as a fallback (decided 2026-11-07). People don't register their own OAuth apps.
- A GitHub App on a host is for team work only: it pushes as its bot and sends pull request events ([ADR 0060](0060-technical-users-and-github-apps.md)). It never signs people in, because a person's own Sessions must reach every repo they can, not only the ones where the App is installed (decided 2026-11-07).
- The name and email to commit with are set per host, picked from the person's verified emails on that host, with a default for repositories on other hosts.

### Profiles

There are three kinds, and setup keeps them apart:

- The **server default Profile** (base, [ADR 0044](0044-base-profile.md)) sits under every Session, personal and team. Server setup offers it in every scenario, solo too, and before models, so the providers its packages add show up in the models step.
- **Your default Profile** (My defaults, [ADR 0063](0063-settings-and-first-run-setup.md)) sits on top of it, under a person's personal Sessions. "Make Pi yours" sets it up.
- **Team Profiles** ([ADR 0064](0064-one-team-per-server.md)) are the concrete Profiles team Sessions run with. The server default sits under them, and no person's default does. Separately, a person may copy one as the start of their own Profile, and the team Profile stays as it is.

"Make Pi yours" offers: copy a team Profile (on a team server), bring `~/.pi/agent`, start from a git repository, or Pi's defaults. Pi's defaults is an answer, so it finishes the step, and the step has no Skip. More Profiles can be made any time in Settings.

### Models

- Server setup only sets shared keys: the providers the server pays for. The admin picks them from every provider Pi knows plus the ones the server default Profile adds. To offer a provider Pi doesn't know, the admin adds its package to the server default Profile.
- Each person can sign in to any provider, with their own account or key. Nothing limits people to the shared providers.
- A person can add a provider's package from the models step. It goes into their default Profile, and its sign-in shows up in the list.

### Every step shows

- No step is skipped behind a person's back. What the server or the team already chose is preselected, so the step takes one click and can still be changed.
- Every step has Back, including from your setup back into server setup for the admin.
- Skip exists only on steps that have no answer yet. A skipped step comes back as a reminder on home, as ADR 0063 says.
- An admin can mark a whole step required for new people. Required applies to a whole step, never to one provider or host, and the plugin decides what done means for its own step.

## Consequences

- This amends ADR 0063: the wizard splits into server setup and your setup, steps come from plugins, and "Start clean" becomes "Pi's defaults", which finishes the step.
- This amends [ADR 0043](0043-git-hosts.md): no default github.com host, and a commit name and email per host instead of one per person.
- This amends ADR 0060: a GitHub App is used for team work only, never to sign people in.
- The plugin SDK gains a server setup step next to the personal one, with a position relative to a kernel step.
