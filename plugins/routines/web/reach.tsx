import { useApi, useLoaded } from "@pipoca/plugins/web";
import { type PrivateHosts, privateHostOf } from "@pipoca/protocol";
import { Button, Notice } from "@pipoca/ui";
import type { ReactElement } from "react";
import { routines } from "../plugin";
import { useEnvironments } from "./common";

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

  const environments = useEnvironments(team);

  const host = privateHostOf(repository, listed.value ?? []);

  if (host === undefined || environments === undefined) {
    return null;
  }

  const reaching = environments.filter(({ reaches }) =>
    reaches.some((each) => each.reached && each.host === host),
  );

  const named = environments.find(({ id }) => id === environment);

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
