import { useApi, useLoaded } from "@pipoca/plugins/web";
import {
  type Environment,
  type PrivateHosts,
  repositoryHost,
} from "@pipoca/protocol";
import { Button, Notice } from "@pipoca/ui";
import type { ReactElement } from "react";
import { routines } from "../plugin";

// Warns when a routine clones a repository on a private host but names an
// Environment that can't reach it, and offers one that can (ADR 0080).
export function ReachWarning({
  repository,
  environment,
  team,
  onUse,
}: {
  readonly repository: string;
  // The id of the Environment the routine names, or empty for any.
  readonly environment: string;
  readonly team: boolean;
  readonly onUse: (environment: string) => void;
}): ReactElement | null {
  const api = useApi(routines);
  const host = repositoryHost(repository);

  // A warning only, so a failed load leaves the routine's page as it is.
  const listed = useLoaded(
    async () =>
      api
        .get<PrivateHosts>("/api/settings/private-hosts")
        .then(({ hosts }) => hosts as PrivateHosts["hosts"] | undefined)
        .catch(() => undefined),
    "private-hosts",
    { topics: ["private-hosts"] },
  );

  const environments = useLoaded(
    async () =>
      api
        .get<readonly Environment[]>(
          `/api/environments${team ? "?scope=team" : ""}`,
        )
        .catch(() => undefined),
    `environments ${String(team)}`,
    { topics: ["environments"] },
  );

  const isPrivate =
    host !== undefined &&
    listed.value?.some((each) => each.host === host) === true;

  if (!isPrivate || environments.value === undefined) {
    return null;
  }

  const reaching = environments.value.filter(({ reaches }) =>
    reaches.some((each) => each.reached && each.host === host),
  );

  const named = environments.value.find(({ id }) => id === environment);

  if (environment === "" && reaching.length > 0) {
    return null;
  }

  if (named !== undefined && reaching.includes(named)) {
    return null;
  }

  const [other] = reaching;
  const whose = team ? "a team Environment" : "an Environment of yours";

  return (
    <Notice
      tone="waiting"
      title={
        named === undefined
          ? `No Environment reaches ${host}`
          : `${named.name} can't reach ${host}`
      }
      action={
        other !== undefined && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              onUse(other.id);
            }}
          >
            Use {other.name}
          </Button>
        )
      }
    >
      {`${nameOf(repository)} lives on a private host. Runs need ${whose} that reaches it.`}
    </Notice>
  );
}

function nameOf(repository: string): string {
  const path = URL.parse(repository)
    ?.pathname.slice(1)
    .replace(/\.git$/, "");

  return path === undefined || path === "" ? repository : path;
}
