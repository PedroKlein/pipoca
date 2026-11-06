import type { Profile, RepositorySource } from "@pipoca/protocol";
import { Button, ErrorText, Icon } from "@pipoca/ui";
import type { ReactElement } from "react";
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";
import { href, navigate } from "../../router";

// A Profile that follows a folder in a repository (ADR 0063). It changes only
// when the repository does, so editing starts from a copy.
export function Synced({
  profile,
  source,
}: {
  readonly profile: Profile;
  readonly source: RepositorySource;
}): ReactElement {
  const sync = useAction(async () =>
    request("profiles.syncs.create", { params: { id: profile.id } }),
  );

  const copy = useAction(async () => {
    const made = await request("profiles.create", {
      body: { from: profile.id },
    });

    navigate(href("settings", { page: "profiles", rest: made.id }));
  });

  const busy = sync.pending || copy.pending;

  return (
    <div
      aria-label="Synced from a repository"
      className="mt-6 flex flex-col gap-3 rounded-lg bg-hover p-4 text-label text-fg"
    >
      <p className="flex gap-2.5">
        <Icon name="lock" className="mt-0.5 size-4 shrink-0 text-fg-dim" />
        <span>
          Follows <span className="font-mono">{source.path}</span> in{" "}
          <span className="font-mono break-all">{source.url}</span> at{" "}
          <span className="font-mono">{source.commit.slice(0, 7)}</span>. It
          changes when the repository does, so make a copy to edit it, or build
          a Profile of your own on it.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={busy}
          onClick={() => {
            void sync.run();
          }}
        >
          Sync now
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            void copy.run();
          }}
        >
          Make a copy
        </Button>
        <ErrorText inline size="caption">
          {sync.error ?? copy.error}
        </ErrorText>
      </div>
    </div>
  );
}
