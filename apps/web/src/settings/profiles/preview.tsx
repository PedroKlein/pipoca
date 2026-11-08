import { Button, cn, Dialog } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useLoad } from "../../data/hooks";
import { SourceTag } from "./inherited";
import type { StackLayer } from "./stack";

// The folder a runner gets for a Session on the Profile, read-only, with
// where each file comes from (ADR 0074).
export function PreviewButton({
  profileId,
  name,
  layers,
}: {
  readonly profileId: string;
  readonly name: string;
  // Every layer from the Server base up to the Profile itself.
  readonly layers: readonly StackLayer[];
}): ReactElement {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen(true);
        }}
      >
        Preview what Pi gets
      </Button>
      {open && (
        <Preview
          profileId={profileId}
          name={name}
          layers={layers}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function Preview({
  profileId,
  name,
  layers,
  onClose,
}: {
  readonly profileId: string;
  readonly name: string;
  readonly layers: readonly StackLayer[];
  readonly onClose: () => void;
}): ReactElement {
  const files = useLoad(
    `profile ${profileId} stacked`,
    async () => request("profiles.stacked", { params: { id: profileId } }),
    { topics: ["profiles"] },
  ).data;

  const paths = Object.keys(files ?? {});
  const [picked, setPicked] = useState<string>();
  const shown = picked ?? paths[0];

  const sourcesOf = (path: string): readonly StackLayer[] =>
    layers.filter((layer) => layer.paths.includes(path));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`What Pi gets with ${name}`}
      description="The folder a runner receives, every layer included and what was turned off left out."
    >
      <div className="flex min-h-80 flex-wrap gap-4 px-6 pb-6">
        <ul
          aria-label="Files"
          className="flex min-w-0 flex-[1_1_200px] flex-col gap-0.5"
        >
          {paths.map((path) => {
            const sources = sourcesOf(path);
            const nearest = sources.at(-1);

            return (
              <li key={path}>
                <button
                  type="button"
                  aria-current={path === shown ? "true" : undefined}
                  onClick={() => {
                    setPicked(path);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-mono-sm text-fg hover:bg-hover",
                    path === shown && "bg-hover",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{path}</span>
                  {sources.length > 1 ? (
                    <span className="font-sans text-caption text-fg-dim">
                      {sources.length} layers
                    </span>
                  ) : (
                    nearest && (
                      <SourceTag
                        name={nearest.name}
                        kind={nearest.id === profileId ? "own" : nearest.kind}
                      />
                    )
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        <pre
          aria-label={shown ?? "File"}
          className="min-w-0 flex-[2_1_320px] overflow-auto rounded-md bg-code p-3 font-mono text-mono-sm whitespace-pre-wrap text-fg"
        >
          {textOf(files, shown)}
        </pre>
      </div>
    </Dialog>
  );
}

function textOf(
  files: Readonly<Record<string, string>> | undefined,
  path: string | undefined,
): string {
  if (files === undefined) {
    return "Reading…";
  }

  return path === undefined
    ? "Pi gets an empty folder: plain Pi."
    : (files[path] ?? "");
}
