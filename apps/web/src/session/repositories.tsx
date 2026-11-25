import { checkoutName, type Session } from "@pipoca/protocol";
import { RepositoryField, SessionSection } from "@pipoca/plugins/web";
import { ErrorText, Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../data/client";
import { useAction } from "../data/hooks";

// The repositories a Session works in, and a way to clone in another one,
// which restarts it with its chat once its turn ends (ADR 0086).
export function RepositoriesSection({
  session,
  archived,
}: {
  readonly session: Session | undefined;
  readonly archived: boolean;
}): ReactElement | null {
  const add = useAction(async (repository: string) =>
    request("sessions.repositories.create", {
      params: { id: session?.id ?? "" },
      body: { repository },
    }),
  );

  if (session === undefined) {
    return null;
  }

  const { workspace } = session;

  if (workspace.kind === "folder" || workspace.kind === "worktree") {
    return null;
  }

  const repositories =
    workspace.kind === "clone"
      ? [workspace.repository]
      : workspace.repositories.map(({ repository }) => repository);

  return (
    <SessionSection
      name="repositories"
      order={80}
      label="Repositories"
      icon="folder"
      button={`Repositories, ${String(repositories.length)}`}
    >
      <ul className="flex flex-col gap-1">
        {repositories.map((repository) => (
          <li
            key={repository}
            className="flex min-w-0 items-center gap-1.5 text-caption"
          >
            <Icon name="folder" className="size-3.5 shrink-0" />
            <span className="truncate font-mono" title={repository}>
              {checkoutName(repository) ?? repository}
            </span>
          </li>
        ))}
      </ul>
      {!archived && (
        <div className="mt-2">
          <RepositoryField
            label="Add repository"
            selected={repositories}
            recent={[]}
            team={session.ownedBy === "team"}
            repositoriesOnly
            onChange={(picked) => {
              const added = picked.find((each) => !repositories.includes(each));

              if (added !== undefined) {
                void add.run(added);
              }
            }}
          >
            <span className="flex items-center gap-1.5">
              <Icon name="plus" className="size-3.5" />
              {add.pending ? "Adding…" : "Add repository"}
            </span>
          </RepositoryField>
          <p className="mt-1 text-caption text-fg-dim">
            The Session restarts with the same chat to clone it in, once Pi
            finishes what it is doing.
          </p>
          <ErrorText className="mt-1">{add.error}</ErrorText>
        </div>
      )}
    </SessionSection>
  );
}
