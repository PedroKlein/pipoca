# 0080: Private hosts reached through Environments

- Status: accepted
- Date: 2026-11-12

## Context

Some hosts only some machines can reach. A company's GitHub Enterprise or Jira often sits inside its network: a VM there reaches it, a Kubernetes cluster outside doesn't, and neither does the server.

Runners dial out to the server and never take calls ([ADR 0032](0032-environments-and-runners.md)). A Session's own git, `gh`, MCP servers and model calls run on its runner. So a Session in an Environment whose machine reaches the host already clones and pushes there with its starter's token ([ADR 0043](0043-git-hosts.md)).

Everything the server does itself fails for such a host:

- The `git-hosts` plugin calls the host's API from the server: connecting an account (checking a token, redeeming OAuth, reading emails), the repo picker, the `git_hosts_repositories` tool, pull request watching and merging ([ADR 0051](0051-pull-request-watching.md)), question replies, polled git events for routines ([ADR 0075](0075-routines-groups-coordinators-and-agents.md)) and GitHub App setup and tokens ([ADR 0060](0060-technical-users-and-github-apps.md)).
- The server runs git itself to push for proposing Sessions and technical users, and to fetch Profiles, templates and plugins from git URLs.
- Routine `watch` URLs, MCP sign-in, the team key proxy ([ADR 0066](0066-team-credentials-and-usage.md)), Slack, email, push and OIDC are server calls too. `watch` refuses private addresses on purpose.

Nothing tells Pipoca which Environments can use a repository either, so the new-session picker offers ones that can't clone it.

Every plugin makes its own calls with `fetch` or a git process. A fix for git hosts alone would have to be built again for the next plugin with the same problem, such as a Jira plugin for a company's own Jira.

There is no server-owned Environment that every person's Sessions share, on purpose: every Environment is one person's, so two people's credentials never meet on one machine ([ADR 0049](0049-personal-environments-and-templates.md)). Team Environments run team Sessions only ([ADR 0064](0064-one-team-per-server.md)).

## Decision

Reaching a host is a fact about machines. The server is one more machine that may not reach a host. The kernel knows which hosts are private, which Environments reach them, and sends the server's own calls to a private host through one of those Environments (decided 2026-11-12). No plugin knows about any of this.

### Admins list private hosts

- Server setup holds a list of private hosts, as `host` or `host:port` with 443 as the default port (decided 2026-11-12). A private host is one the server doesn't reach directly.
- The list is the kernel's. A plugin's settings for a host, such as a git host or a Jira site, show admins a Private switch that edits the same list. Plugins can't change the list themselves.
- Every host not on the list is public. Calls to it go direct, as today.

### Environments declare what they reach

- A machine's owner names the private hosts it may relay to when the runner joins, such as `pipoca runner --reach github.tools.sap`. Naming a host is the owner's consent to relay to it, and it lives on the machine, so the server can't add hosts to it. Names are exact `host` or `host:port`: no wildcards, IP addresses or `localhost`.
- A pod template names them for its pods. The server writes a pod's spec, so that reach is the admin's grant, not the owner's consent, and the Environment page says so.
- At start the runner opens a TLS connection to each one and reports which it reached. An Environment reaches a host when one of its runners reported it.
- The Environment page shows the hosts it reaches and whether each one answered.

### Calls name who they are for

- Plugins make network calls through the kernel: `network.fetch` for HTTP, and `network.env` for the variables a child process such as git or `gh` needs. Each call has an owner, a person or the team ([ADR 0064](0064-one-team-per-server.md)). The plugin lint refuses the global `fetch` and raw sockets, as it already refuses timers.
- The kernel takes the owner from what the plugin is handling: the person behind a request, the Session's starter, or the owner of the schedule, event or routine run. A plugin can't name a person it isn't acting for. Team calls need team work behind them. A technical user's calls are the team's ([ADR 0060](0060-technical-users-and-github-apps.md)).
- `network.env` points the process at a proxy the server runs on loopback. It takes a ticket that is random, bound to the owner and one `host:port`, and ends when the process exits or after minutes at most. The ticket travels in a header or a file only the process can read, never in a URL, and is masked in errors people see. The proxy refuses anything without a ticket. The proxy and `network.fetch` share one router.
- For a private host the router picks:
  - a call for a person goes through an online runner of one of **that person's own** Environments that reaches the host;
  - a call for the team goes through an online runner of a **team** Environment that reaches it.
- A person's Environment never carries the team's calls or anyone else's, and a team Environment never carries one person's (decided 2026-11-12). So connecting an account on a private host needs the person's own Environment that reaches it, and the team's bot on that host needs a team Environment that does.
- With no route the call fails with one kernel error, `Unreachable`, that names the host and why, such as no Environment of yours reaches it, or its runner is offline. The UI shows it the same way for every plugin, with a link to Environments.

### The relay is a tunnel, not a proxy

- A runner whose Environment reaches a private host keeps a relay socket open to the server, like the sockets previews already use ([ADR 0037](0037-previews-and-opened-pages.md)). It signs in with a relay credential of its own, not the runner token Sessions can read ([ADR 0032](0032-environments-and-runners.md)).
- The router opens a tunnel over it to the host's port, as HTTP `CONNECT` does. TLS runs from the server to the host inside it. The runner forwards bytes: it sees no tokens and no content, and no Session or plugin code runs on its machine for this.
- The runner refuses a tunnel to any host:port its owner didn't name, and to a name that resolves to a loopback or link-local address.
- Calls to a private host are `https` only, and the certificate is checked for the listed name. A host's own CA certificate, when it has one, is set by an admin with the private host, trusted for that host alone and given to child processes too. Checking is never turned off.
- Redirects are followed by the router, one hop at a time, each routed and checked again. A hop from a public host to a private one, or to another private host, is refused, and credentials never follow a hop to another host.
- Connections are never pooled or reused across owners or Environments.
- The server confirms a reported host with its own TLS handshake through the tunnel before it uses the route.
- Revoking a runner, deleting an Environment, removing a host from the list or removing a person closes their tunnels at once and fails the calls waiting on them.
- The server logs every tunnel with its owner, plugin, host, runner, bytes and duration, and the runner logs its own. Both sides cap open tunnels, their rate and how long one may sit idle.
- ssh to a private host is refused until host keys can be pinned per host.

### Placement follows reach

- A Session whose Workspace is a repository on a private host starts only in an Environment that reaches it. The new-session picker leaves out the others and says why.
- Saving a routine, or a Project's default Environment, checks the same rule.
- This is about the Workspace's host only. A plugin whose Session part needs a private host, such as an MCP server, can't ask for placement yet.

### What moves onto it

- In `git-hosts`, `reach` becomes `network.fetch`, and the server's pushes use `network.env`, each for the person or technical user it acts for.
- Fetching Profiles, templates and plugins from git uses `network.env`, for the person who asked or for the team when an admin did.
- Routine `watch` still refuses private addresses, except a listed private host, which goes through the router for the routine's owner. Only admins may point a team routine's `watch` at a private host, since every user can start team routines ([ADR 0064](0064-one-team-per-server.md)).
- MCP sign-in, the key proxy, Slack, email, push and OIDC use `network.fetch` too. They gain nothing until someone lists their host as private.

## Consequences

- A plugin that talks to a host inside a company network, such as a future Jira plugin, works there by calling `network.fetch` for the right owner. It needs no code of its own for this.
- Calls to a private host need the relaying machine on. While a VM is off, pull request watching and git event polling for its hosts pause and show why, and connecting an account fails with `Unreachable`.
- A machine inside a company network opens a tunnel from an outside server to the hosts its owner names. While it is online, whoever controls the server can reach those hosts with the tokens the server keeps. Today those tokens are useless from outside, so a server compromise reaches further, and a company's policy may forbid this.
- The relaying machine sees which host each tunnel goes to, when and how much, but not its content.
- Webhooks from a private host still need the host to reach the server. Where it can't, git events come by polling through the relay.
- Personal Sessions in a cluster that can't reach a private host still can't work on its repositories. Each person who needs that joins a machine of their own.
- Running several people's Sessions on one shared machine still needs isolation per person, which this doesn't add.

## As built

Where the first build differs from the decision above (2026-11-12):

- Plugins pass the owner to `network.fetch` and `network.env` themselves, from the caller, Session or routine they handle. The kernel doesn't derive it yet, so a plugin could name an owner it isn't acting for.
- The relay signs in with the runner's own token. A separate relay credential is left for later.
- git gets its ticket as the password in the proxy address of an `http.<url>.proxy` entry in its environment, since git asks no credential helper for proxy credentials without a prompt. Only the process and the server see it.
- The tunnel log is kept in memory, the last 50 per Environment, and is lost on restart.
- Tunnels have a 10 second open timeout and 16 open per runner on each side, and an idle limit of 5 minutes on the runner. There is no rate limit yet.

## Later

- Sending a Session's own traffic for a private host through the server's router, so pods could clone from it without a machine of their own. Every Session's code could then reach that host through the relay, which makes the policy question wider.
- Letting a plugin's Session part ask for an Environment that reaches its host.
