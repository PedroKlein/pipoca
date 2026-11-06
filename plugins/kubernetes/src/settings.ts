// A Kubernetes Environment's runner pods (ADR 0032). With "claim", each
// Session gets a pod of its own that mounts a claim of claimSize, so its
// workspace outlives the pod; capacity doesn't apply. The patch is a JSON
// merge patch on the pod, so a list in it, such as containers, replaces the
// whole list.
export const workspaces = ["pod", "claim"] as const;

export interface KubernetesSettings {
  readonly workspace: (typeof workspaces)[number];
  readonly capacity: number;
  readonly maxPods: number;
  readonly idleSeconds: number;
  readonly claimSize: string;
  readonly storageClass: string | null;
  readonly podPatch: Readonly<Record<string, unknown>>;
}

// What the plugin's route answers for an Environment or a template. Without
// settings it starts no pods there; outside a cluster it starts none
// anywhere. An Environment made from a template shows the template's, which
// only admins change, on the template (ADR 0049).
export interface KubernetesEnvironment {
  readonly settings: KubernetesSettings | null;
  readonly startsPods: boolean;
  readonly lastFailure: PodFailure | null;
  readonly editable: boolean;
}

// The last runner pod of an Environment that failed, while no pod since has
// joined. The next pod waits until retryAt.
export interface PodFailure {
  readonly pod: string;
  readonly problem: string;
  readonly at: string;
  readonly retryAt: string;
}

export const defaultSettings: KubernetesSettings = {
  workspace: "pod",
  capacity: 1,
  maxPods: 5,
  idleSeconds: 300,
  claimSize: "10Gi",
  storageClass: null,
  podPatch: {},
};
