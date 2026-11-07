# pipoca-kyma

Pipoca on SAP BTP's Kyma ([ADR 0073](../../../docs/adr/0073-kyma-chart-on-the-plain-chart.md)). It takes the plain chart in `deploy/helm/pipoca` as a subchart and adds:

- the APIRule that puts the server behind Kyma's gateway, and the Istio policy that lets runner pods reach `/runner`
- previews at `*.<host>`, with their own certificate, gateway and APIRule, when `apiRule.previews` is on
- Istio's sidecar for the server pod, `trustProxy`, and the inject label on the seeded pod template, so runner pods join the mesh

The plain chart's values go under `pipoca:`. The guide's [On Kyma](../../../docs/guide.md#on-kyma) section has the rest.

```sh
helm dependency build deploy/helm/pipoca-kyma
helm install pipoca deploy/helm/pipoca-kyma --namespace pipoca --create-namespace \
  --set pipoca.url=https://pipoca.<cluster domain>
```

The APIRule passes only the `/api` paths it lists. After a change to the route table, run `bun run apirule` in this folder to write them again; `bun test` fails until you do.

## Upgrading a release of the plain chart

Before this chart, `deploy/helm/pipoca` held the Kyma parts behind `apiRule.enabled`. Both charts name every resource after the release, so upgrading the same release to this chart keeps its PersistentVolumeClaim (`<release>-data`), its secret key Secret (`<release>-secret-key`), its Deployment and its Service.

1. Keep the release name and namespace.
2. Move the values under `pipoca:`, except `apiRule`. Drop `apiRule.enabled`, since this chart always has the APIRule, and set `pipoca.url` to `https://<apiRule.host>`, which the old chart filled in for you. The APIRule takes its host from `pipoca.url`, unless `apiRule.host` names another.

   ```yaml
   # Before, for deploy/helm/pipoca
   apiRule:
     enabled: true
     host: pipoca.example.kyma.ondemand.com
     previews: true
   config: { ... }

   # After, for deploy/helm/pipoca-kyma
   pipoca:
     url: https://pipoca.example.kyma.ondemand.com
     config: { ... }
   apiRule:
     previews: true
   ```

3. Runner pods used to join the mesh through `PIPOCA_RUNNER_MESH`, which is gone. The chart seeds its pod template with the inject label only when the data volume has no `pipoca.json` yet, so add `"labels": {"sidecar.istio.io/inject": "true"}` to the `kubernetes` settings of each pod template that already exists, in the data volume's `pipoca.json` or by reading `GET /api/ext/kubernetes/templates/<id>` and posting its settings back with the label. Without it, the Istio policy turns new runner pods away.
4. Check that nothing holding data is replaced. Compare the kinds and names the release has with the ones this chart renders, then diff against the cluster with the [helm-diff](https://github.com/databus23/helm-diff) plugin:

   ```sh
   names() { grep -A3 '^kind:' | grep -E '^kind:|^  name:' | paste - - | sort; }
   helm get manifest pipoca -n pipoca | names > old.txt
   helm template pipoca deploy/helm/pipoca-kyma -n pipoca -f new.yaml | names > new.txt
   diff old.txt new.txt
   helm diff upgrade pipoca deploy/helm/pipoca-kyma -n pipoca -f new.yaml
   ```

   `diff` should show only what the chart adds or drops, never the PersistentVolumeClaim or the Secret, and `helm diff` should show no change to either. `helm template` can't read the existing Secret, and neither can `helm diff` unless it runs with `--dry-run=server`, so its `secretKey` may show as a new random one; the upgrade itself reuses the key that is there. Both carry `helm.sh/resource-policy: keep`, so Helm never deletes them.

5. `helm upgrade pipoca deploy/helm/pipoca-kyma -n pipoca -f new.yaml`.
