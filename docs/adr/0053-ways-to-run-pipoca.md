# 0053: Ways to Run Pipoca

- Status: accepted
- Date: 2026-11-01

## Context

Pipoca is for one person or a small team of about 10 to 15 people (decided 2026-11-01). Larger installs come much later, so one server replica on SQLite stays.

People will run it in four ways:

1. **On one machine.** Browser, server and runners all on a laptop or desktop, maybe with a VM joined as another runner. They want several kinds of local runners: their own folders, clean containers, a Project's threads sharing one container.
2. **Server on a VM, laptop as a runner.** The server runs on an always-on VM, reached through an SSH tunnel. The laptop joins as a runner and opens the UI through the same tunnel.
3. **A team's server.** A platform team runs Pipoca, usually on Kubernetes, with templates, a base Profile and plugins it chose. People sign in through the browser.
4. **Multiplayer.** Like 3, but several people work in the same Session, Project or plugin feature.

All four are the same `pipoca` binary in different places, and parts of each work today:

- `pipoca server --provider <name> --folder <path>` starts the server with a built-in runner ([ADR 0012](0012-built-in-provider.md)). That runner is one Environment. Its isolation is `process` or `container`, and `container` runs each Session in its own Docker or Podman container ([ADR 0032](0032-environments-and-runners.md#isolation)). A second local Environment means starting another `pipoca agent` by hand.
- The `kubernetes` plugin reaches a cluster only through the server pod's own service account, and its runner pods dial the server's in-cluster Service ([ADR 0032](0032-environments-and-runners.md#how-the-kubernetes-plugin-works-decided-2026-10-25)). A server on a laptop can't start pods in a local k3s.
- Scenario 2 is the v1 shape ([ADR 0005](0005-v1-access-and-model-credentials.md), [ADR 0009](0009-vm-deployment-and-testing.md)). Keeping the tunnel up and starting the agent at login are manual.
- Scenario 3 runs on Kyma: sign-in through OIDC groups ([ADR 0038](0038-single-sign-on-and-admins.md)), personal Environments from admin templates ([ADR 0049](0049-personal-environments-and-templates.md)), a base Profile ([ADR 0044](0044-base-profile.md)). Every person's runner pods share the server's namespace with nothing between them, so one person's pod can reach another's open ports.
- A loopback bind needs a login and runner keys ([ADR 0033](0033-v2-authentication-and-order.md#authentication)), so even a single person on their own laptop goes through the setup link and a password.

Whether Pipoca should ship as a desktop app was also open ([open-questions.md](../open-questions.md#extension-system) asked whether an integrated browser belongs in one).

## Decision

### A local machine source

- A first-party `local` plugin starts runners on the server's own machine, on the machine source seam the `kubernetes` plugin uses ([ADR 0032](0032-environments-and-runners.md#kubernetes-is-a-plugin)). It starts a runner when a Session queues in one of its Environments, and the runner exits when idle (decided 2026-11-01).
- Its runners use the isolation the Environment names: `process` Sessions work in the machine's own folders, `container` Sessions each get a container from the Environment's image. A runner can also run inside a container from the image with a capacity above one, so several Sessions, such as a Project's threads, share that container as they would share a pod.
- So one machine hosts several Environments, such as "my checkouts", "clean Node 22" and "Python data", with no agent started by hand.
- The plugin is on only in a solo install (below). A team server's machine holds the sealing key and everyone's data, so on a team server people's runners come from pods, from machines they join, or from another machine source plugin ([ADR 0049](0049-personal-environments-and-templates.md#the-servers-own-runner)).
- The `kubernetes` plugin doesn't learn kubeconfig for now. On one machine, k3s adds a VM and a second scheduler to get what container isolation already gives. Testing pod templates against a local cluster can bring it back.

### Solo installs

- An install is solo or not by an explicit setting, chosen at setup or with a server flag, never guessed from the bind address (decided 2026-11-01). The server can't tell an SSH tunnel from a reverse proxy, since both reach it on loopback, and a wrong guess would leave a public server open.
- A solo install has one user, an admin. Adding users, OIDC providers and the People page are off.
- Authentication stays on, as ADR 0033 requires for loopback. The person never sees a password page: `pipoca up` and `pipoca connect` (below) open the browser with a one-time sign-in link, like the setup link, which they get from the server over a channel only the server's operating system user can read. Another device, such as a phone, gets a link from Settings.
- Turning a solo install into a team one is an admin action that turns those parts on. Going back is not offered.

### No desktop app yet

- Pipoca doesn't ship a desktop app for now (decided 2026-11-01). The binary gets the commands that cover what an app would do for scenarios 1 and 2:
  - `pipoca up` starts a solo server with the `local` plugin and opens the browser signed in.
  - `pipoca connect user@host` holds an SSH tunnel to a remote server with reconnects, runs this machine as a runner through it, and opens the browser signed in.
  - `pipoca service install` runs either one at login, as a launchd or systemd unit.
- The web UI becomes installable as an app, with a manifest and icons, so it gets its own window and dock icon. A team's URL installs the same way, which covers "point the app at a server and sign in".
- A desktop app is reconsidered when Pipoca needs what only a native shell gives: a real browser the agent drives, real file paths from a folder picker, or the operating system's keychain.

### Walls between people on a team server

- Runner pods stay in the server's namespace (decided 2026-11-01). A NetworkPolicy from the Helm chart refuses all incoming connections to runner pods. Nothing needs them: runners dial the server, and previews and terminals travel over sockets the Session host opens to the server ([ADR 0037](0037-previews-and-opened-pages.md#the-proxy)). Outgoing traffic stays open, as network rules are still deferred ([ADR 0034](0034-v2-deployment-and-credentials.md#v2-scope)).
- Admins set a most-pods limit per person, which Pipoca counts across all of that person's Environments, next to each template's limit per Environment.
- A namespace per person isn't built. It needs a ClusterRole to create namespaces, and a team of 10 to 15 doesn't need Kubernetes quotas per person. A template could later name its namespace, if a platform team wants GPU or restricted work kept apart.

## Consequences

- One laptop can run several Environments with no hand-started agents, and a Project's threads can share one container.
- Scenario 1 needs Docker or Podman for anything but process Sessions, as container isolation already does.
- A solo install keeps one code path for authentication, and a person on their own machine never types a password.
- `pipoca up`, `pipoca connect` and `pipoca service install` are new commands to build and test on macOS and Linux. Windows isn't covered.
- No signing, notarization or update channel for a desktop app, until one of its real reasons comes up.
- One person's runner pod can no longer reach another's ports. A team that needs pods to accept connections, such as a database another pod serves, has to wait for network rules.
- A local k3s can't be driven from a laptop server until the `kubernetes` plugin learns kubeconfig.
