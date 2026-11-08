---
title: In Kubernetes
description: Install the server with Helm and start runner pods on demand, Kyma included.
sidebar:
  order: 5
---

The `Dockerfile` builds an image that runs the server, and the chart in `deploy/helm/pipoca` installs it on any cluster, with one replica and its data on a ReadWriteOnce volume ([ADR 0034](../adr/0034-v2-deployment-and-credentials.md)). The `kubernetes` plugin then starts runner pods for people's Environments when their Sessions need them, and deletes them when they go idle.

## Install the chart

```sh
helm install pipoca deploy/helm/pipoca --set url=https://pipoca.example.com
kubectl logs deploy/pipoca | grep setup
```

Open the setup link from the log to create the first admin, then go through [setup](team.md#set-it-up). On install the chart makes a Secret holding the secret key, and keeps it on upgrades and uninstalls. Give your own with `existingSecret`, a Secret with a `secretKey` entry of 32 bytes in base64.

Put HTTPS in front with your gateway, and set `url` to where people open it. On a cluster with an ingress controller, `ingress.enabled=true` adds a standard Ingress for the host of `url` (or `ingress.host`), with `ingress.className`, `ingress.annotations` and `ingress.tls` passed through. When every request comes through that gateway, `trustProxy=true` counts failed sign-ins by the client address it forwards.

| Value                         | What it does                                                                                                    | Default             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------- |
| `url`                         | Where people open the server. The setup link points here.                                                       |                     |
| `image.tag`                   | `main` follows the main branch. Pin a `sha-<commit>` tag for a steady install.                                  | `main`              |
| `ingress.*`                   | A standard Ingress for the host of `url`.                                                                       | off                 |
| `trustProxy`                  | Read the client address from `X-Forwarded-For`.                                                                 | `false`             |
| `existingSecret`              | A Secret with the `secretKey` that seals secrets and logins.                                                    | one the chart makes |
| `persistence.size`            | The data volume, with SQLite, config, Session files and artifacts.                                              | `5Gi`               |
| `runnerPods.enabled`          | A service account that may manage pods, Secrets and claims in the namespace, for runner pods.                   | `true`              |
| `runnerPods.refuseIncoming`   | A NetworkPolicy that refuses every incoming connection to runner pods, so people's pods can't reach each other. | `true`              |
| `builtInRunner`               | Also run a runner inside the server pod, in the Environment of this name. Only with `runnerPods.enabled=false`. |                     |
| `config`                      | The first `pipoca.json`, written only when the data volume has none yet.                                        | `{}`                |
| `lockedConfig`                | Keys the chart owns, mounted read-only. Settings shows them without letting anyone change them.                 | `{}`                |
| `extraEnv`, `extraEnvFrom`    | More environment for the server, such as a client secret from a Kubernetes Secret.                              | `[]`                |
| `podLabels`, `podAnnotations` | More labels and annotations on the server's pod.                                                                | `{}`                |

Every push to main publishes the image as `ghcr.io/pedroklein/pipoca:main` and `:sha-<commit>`. The image runs the server with `--supervise`, so a restart that a plugin asks for happens inside its container and the kubelet doesn't count it as a crash.

## Runner pods

Pods come from a pod template, an Environment template with pod settings ([ADR 0049](../adr/0049-personal-environments-and-templates.md)). With `runnerPods.enabled` and no `templates` in `config`, the chart seeds one named **Kubernetes pods**, so the first person can pick the cluster in setup. Each person then makes an Environment from that template and gets pods of their own, which never serve anyone else.

When some of an Environment's Sessions can't go to any runner, the plugin starts one pod for each `capacity` of them, up to `maxPods`. A pod runs the Environment's image, or the Pipoca image when it names none, with the `pipoca` binary copied in. Its agent stops after `idleSeconds` without a Session, and the plugin then deletes the pod and its token.

An admin sets a template's pod settings in its Kubernetes section under Templates on the Environments page:

| Setting                     | What it does                                                                                                                            | Default |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `workspace`                 | `pod`: a workspace lives as long as its pod. `claim`: each Session gets a pod of its own with a persistent claim.                       | `pod`   |
| `capacity`                  | Sessions per pod, for `pod` workspaces.                                                                                                 | `1`     |
| `maxPods`                   | Pods per Environment.                                                                                                                   | `5`     |
| `idleSeconds`               | How long a pod's agent waits without a Session before it stops.                                                                         | `300`   |
| `claimSize`, `storageClass` | The claim for `claim` workspaces, on the cluster's default storage class unless named.                                                  | `10Gi`  |
| `labels`, `annotations`     | Added to each pod, such as a service mesh's inject label.                                                                               |         |
| `podPatch`                  | A JSON merge patch on the pod, such as `{"spec": {"nodeSelector": {"pool": "agents"}}}`. It can't give the pod a service account token. |         |

Only admins change these settings, since a patch can still mount the namespace's Secrets. [Environments and runners](../admin/environments.md#runner-pods) has the rest: what happens to unfinished work when a pod stops, failures and backoff, and how pods are replaced after an upgrade.

Pods run Sessions as processes, so the Environment's isolation must be `process`. With `"workspace": "pod"`, use clone or repositories workspaces, since nothing on the pod outlives it. After every turn and as the pod stops, the `files` plugin keeps each checkout's unfinished work on the server, and the next pod puts it back.

## Runners outside the cluster

Agents on other machines, such as people's laptops, join with an Environment's key as on any server: `PIPOCA_KEY=pck_… pipoca agent --server https://pipoca.example.com`. They need to reach `/runner` through your gateway.

## On Kyma

`deploy/helm/pipoca-kyma` is the chart for SAP BTP's Kyma ([ADR 0073](../adr/0073-kyma-chart-on-the-plain-chart.md)). It takes the plain chart as a subchart, so the plain chart's values go under `pipoca:`, and it puts the server behind Kyma's gateway at the host of `pipoca.url`:

```sh
helm dependency build deploy/helm/pipoca-kyma
helm install pipoca deploy/helm/pipoca-kyma --namespace pipoca --create-namespace \
  --set pipoca.url=https://pipoca.<cluster domain>
```

The gateway lets through only what a browser needs: the web UI, sign-in and the `/api` routes it calls. The setup link, the runner routes under `/runner` and `/api/mcp` stay closed, so open the setup link through `kubectl port-forward svc/pipoca 7420`.

- Runner pods reach the server through its Service. The chart adds an Istio policy that lets pods in the namespace reach `/runner`, gives the server's pod Istio's sidecar, and seeds its pod template with `"labels": {"sidecar.istio.io/inject": "true"}` so runner pods get it too. A pod template of your own needs the same label.
- Sign-ins come only through the gateway, so the chart sets `pipoca.trustProxy`.
- `apiRule.exposeAgents=true` opens `/runner` for runners outside the cluster, such as a laptop, and `apiRule.exposeMcp=true` opens `/api/mcp` for [MCP clients](../use/assistant.md#mcp-clients).
- Previews ([ADR 0037](../adr/0037-previews-and-opened-pages.md)) live at `<port>--<session>.<host>`, a level deeper than Kyma's own certificate and gateway reach. `apiRule.previews=true` gives them a wildcard certificate from Gardener's certificate service, a gateway that serves it, and an APIRule that sends every path on `*.<host>` to the server, which admits a browser to a preview only with a grant it handed out.

To move a release of the plain chart to this one, see the chart's [README](../../deploy/helm/pipoca-kyma/README.md).

## Sign-in and config from the chart

Put the server's first `pipoca.json` under `config`, such as single sign-on providers. The chart writes it to the data volume only when no `pipoca.json` is there yet; after that, edit the file or use Settings. To keep a key in the chart instead, put it under `lockedConfig`: its keys win over the same keys in the data volume's file, and Settings shows them as set in the config file without letting anyone change them. [Single sign-on](../admin/single-sign-on.md) has an example.
