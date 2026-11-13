import type { ReactElement } from "react";

const manifestDocs =
  "https://pipoca.dev/docs/use/profiles/#profiles-from-a-repository";

const manifestExample = `{ "profiles": [ { "name": "My Pi", "path": ".pi/agent" } ] }`;

// What to add when a repository lists no Profile.
export function NothingListed({
  found,
}: {
  readonly found: boolean;
}): ReactElement {
  return (
    <div
      role="group"
      aria-label="Nothing listed"
      className="flex flex-col gap-2 rounded-lg border border-line bg-bg p-4"
    >
      <span className="text-ui font-medium text-fg-strong">
        {found
          ? "This repository's pipoca.json lists no Profiles"
          : "No pipoca.json at the root of this repository"}
      </span>
      <span className="text-label text-fg-dim">
        Add one that points at your Pi config, push, then look again:
      </span>
      <code className="rounded-md bg-elevated px-3 py-2 font-mono text-mono-sm text-fg">
        {manifestExample}
      </code>
      <a
        href={manifestDocs}
        target="_blank"
        rel="noreferrer"
        className="self-start text-label text-fg underline"
      >
        How pipoca.json works
      </a>
    </div>
  );
}
