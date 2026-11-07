# 0073: Kyma gets its own chart on top of a plain Kubernetes chart

- Status: accepted
- Date: 2026-11-07

## Context

Kyma is one flavor of Kubernetes. It reaches workloads through its APIRule CRD and Istio. Today its pieces are mixed into the generic parts of Pipoca:

- The chart `deploy/helm/pipoca` ships an APIRule (`apirule.yaml`), an Istio Gateway, certificate and APIRule for previews (`previews.yaml`), and always injects the Istio sidecar into the server pod. It sets `PIPOCA_RUNNER_MESH` whenever `apiRule.enabled` is on.
- The server package holds `apps/pipoca/src/apirule.ts`, which writes the API path list into the APIRule template, with its test and an `apirule` script.
- The kubernetes plugin has a `mesh` option that puts the Istio inject label on runner pods.

A cluster without Kyma or Istio gets templates it can't use, and the kernel and the kubernetes plugin know about a vendor's gateway.

## Decision

- Nothing about Kyma lives in the kernel, the server package or the kubernetes plugin (decided 2026-11-07).
- `deploy/helm/pipoca` is a plain chart for any cluster: Deployment, Service, storage, RBAC, NetworkPolicy, and an optional standard Ingress. It has no Istio or Kyma resources and no sidecar annotation.
- `deploy/helm/pipoca-kyma` is the Kyma flavor. It uses the plain chart as a subchart and adds the APIRule, the previews gateway, certificate and APIRule, and sidecar injection for the server. The script that writes the API path list into the APIRule moves there, out of `apps/pipoca`.
- The kubernetes plugin drops `mesh` and `PIPOCA_RUNNER_MESH`. A pod template can carry extra labels and annotations for runner pods instead. The Kyma chart seeds its pod template with the Istio inject label, so runners still join the mesh.
- CI installs the plain chart in kind, and renders and checks the Kyma chart, including the rule that keeps runners and MCP out of the APIRule.

## Consequences

- The plain chart names its resources after the release, so a release upgraded from `pipoca` to `pipoca-kyma` keeps its names and volume. Before upgrading Kyma, check with `helm diff` or `helm template` that no PersistentVolumeClaim or Secret is replaced.
- Kyma upgrades use `deploy/helm/pipoca-kyma` with values nested under the subchart's key. The guide gets a Kyma section, and the plain chart's guide no longer mentions Kyma.
- Other flavors, such as OpenShift Routes, follow the same pattern: a chart of their own on top of the plain one.
