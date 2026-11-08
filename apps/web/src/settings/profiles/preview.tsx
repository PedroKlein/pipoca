import { apiPath } from "@pipoca/protocol";
import { Button, cn, Dialog } from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { request } from "../../data/client";
import { useLoad } from "../../data/hooks";
import { SourceTag } from "./inherited";
import { inherited, itemsOf, type StackLayer } from "./stack";

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

// A file at the top of the folder, or one folder or file inside a folder
// such as skills/review/.
interface Item {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  // The file it opens.
  readonly path: string;
  readonly off: boolean;
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

  const items = itemsIn(files ?? {}, files === undefined ? [] : layers);
  const [picked, setPicked] = useState<string>();
  const shown = items.find(({ key }) => key === (picked ?? items[0]?.key));

  const sourcesOf = (key: string): readonly StackLayer[] =>
    layers.filter((layer) =>
      layer.paths.some((path) => path === key || path.startsWith(`${key}/`)),
    );

  const groups = [...new Set(items.map(({ group }) => group))];

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`What Pi gets with ${name}`}
      description={`The folder a runner receives: ${layers.map((layer) => layer.name).join(", ")} layered, with what ${name} turned off left out. Read-only.`}
    >
      <div className="flex min-h-80 flex-wrap gap-4 px-6">
        <ul
          aria-label="Files"
          className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5"
        >
          {groups.map((group) => (
            <li key={group} className="flex flex-col gap-0.5">
              {group !== "" && (
                <span className="px-2 pt-2 pb-1 font-mono text-mono-sm text-fg-dim">
                  {group}/
                </span>
              )}
              <ul className="flex flex-col gap-0.5">
                {items
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <li key={item.key}>
                      <FileButton
                        item={item}
                        current={item.key === shown?.key}
                        sources={sourcesOf(item.key)}
                        profileId={profileId}
                        owner={name}
                        onPick={() => {
                          setPicked(item.key);
                        }}
                      />
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
        <div className="flex min-w-0 flex-[2_1_320px] flex-col gap-2">
          <pre
            aria-label={shown?.path ?? "File"}
            className="min-h-60 flex-1 overflow-auto rounded-md bg-code p-3 font-mono text-mono-sm whitespace-pre-wrap text-fg"
          >
            {textOf(files, shown, layers)}
          </pre>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line px-6 py-4">
        <span className="flex-1 text-caption text-fg-dim">
          The lines naming each layer are only shown here; Pi gets the text
          joined by blank lines.
        </span>
        <a
          href={apiPath("profiles.archive", {
            params: { id: profileId },
            query: { stacked: true },
          })}
          download={`${profileId}.tar.gz`}
          className="inline-flex h-control items-center rounded-md border border-line bg-elevated px-3 text-ui font-medium text-fg shadow-xs hover:bg-hover"
        >
          Download .tar.gz
        </a>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}

function FileButton({
  item,
  current,
  sources,
  profileId,
  owner,
  onPick,
}: {
  readonly item: Item;
  readonly current: boolean;
  readonly sources: readonly StackLayer[];
  readonly profileId: string;
  readonly owner: string;
  readonly onPick: () => void;
}): ReactElement {
  const nearest = sources.at(-1);

  if (item.off) {
    return (
      <span className="flex w-full items-center gap-2 px-2 py-1.5 font-mono text-mono-sm text-fg-dim">
        <s className="min-w-0 flex-1 truncate">{item.label}</s>
        <span className="font-sans text-caption">Off in {owner}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-mono-sm text-fg hover:bg-hover",
        current && "bg-hover",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
  );
}

// The folder's items, top-level files first, then each folder's, with what
// a layer below has but the runner doesn't get, which was turned off.
function itemsIn(
  files: Readonly<Record<string, string>>,
  layers: readonly StackLayer[],
): readonly Item[] {
  const items = new Map<string, Item>();

  const add = (path: string, off: boolean): void => {
    const [first = "", second, ...rest] = path.split("/");
    const nested = second !== undefined;
    const key = nested ? `${first}/${second}` : first;

    if (items.has(key)) {
      return;
    }

    const opens = nested && rest.length > 0 ? folderFile(files, key) : path;

    items.set(key, {
      key,
      group: nested ? first : "",
      label: nested && rest.length > 0 ? `${second}/` : (second ?? first),
      path: opens,
      off,
    });
  };

  for (const path of Object.keys(files).sort()) {
    add(path, false);
  }

  for (const path of layers.slice(0, -1).flatMap((layer) => layer.paths)) {
    add(path, true);
  }

  return [...items.values()].sort(
    (a, b) =>
      Number(a.group !== "") - Number(b.group !== "") ||
      a.group.localeCompare(b.group) ||
      a.key.localeCompare(b.key),
  );
}

// The file a folder opens with: its SKILL.md, or else its first file.
function folderFile(
  files: Readonly<Record<string, string>>,
  folder: string,
): string {
  const inside = Object.keys(files)
    .filter((path) => path.startsWith(`${folder}/`))
    .sort();

  return inside.find((path) => path.endsWith("/SKILL.md")) ?? inside[0] ?? "";
}

const joined = {
  "AGENTS.md": itemsOf.agents,
  "APPEND_SYSTEM.md": itemsOf.append,
} as const;

function isJoined(path: string): path is keyof typeof joined {
  return path in joined;
}

function textOf(
  files: Readonly<Record<string, string>> | undefined,
  item: Item | undefined,
  layers: readonly StackLayer[],
): string {
  if (files === undefined) {
    return "Reading…";
  }

  if (item === undefined) {
    return "Pi gets an empty folder: plain Pi.";
  }

  const parts = isJoined(item.path) ? partsOf(item.path, layers) : [];

  return parts.length > 1
    ? parts
        .map(({ from, text }) => `── from ${from} ──\n${text.trim()}`)
        .join("\n\n")
    : (files[item.path] ?? "");
}

// Each layer's part of a text Pi joins, bottom up, without the parts the
// open layer or one between turned off.
function partsOf(
  path: keyof typeof joined,
  layers: readonly StackLayer[],
): readonly { readonly from: string; readonly text: string }[] {
  const own = layers.at(-1);

  if (own === undefined) {
    return [];
  }

  return [
    ...inherited(layers.slice(0, -1), own, joined[path])
      .filter(({ off }) => !off)
      .map(({ from, item }) => ({ from: from.name, text: item })),
    ...joined[path](own).map(([, text]) => ({ from: own.name, text })),
  ];
}
