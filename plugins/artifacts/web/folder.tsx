import { mimeOf, previewKind } from "@pipoca/plugins";
import { useApi, useLoaded } from "@pipoca/plugins/web";
import { buttonClass, cn, ErrorText, Segmented } from "@pipoca/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { artifacts as plugin } from "../plugin";
import {
  type ArtifactView,
  bytes,
  maxFiles,
  textFile,
  type VersionFile,
  type VersionFiles,
  versionOf,
} from "../src/artifacts";
import { type DiffLine, lineDiff } from "../src/diff";
import { DiffView, fetched, fetchedBytes } from "./versions";

type How = "changes" | "whole";

// A file of the version, or one the save before had and this one doesn't.
type Row = Omit<VersionFile, "change"> & {
  readonly change: VersionFile["change"] | "removed";
};

// A folder's files in one version: which it changed against the save
// before, and each file's changes or whole text (ADR 0085).
export function FolderFiles({
  artifact,
  version,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
}): ReactElement {
  const api = useApi(plugin);
  const [picked, setPicked] = useState<string>();
  const [how, setHow] = useState<How>("changes");

  const { value: listed } = useLoaded(
    async () =>
      api
        .get<VersionFiles>(
          `artifacts/${artifact.id}/files?v=${String(version)}`,
        )
        .catch(() => "failed" as const),
    `${artifact.id}:${String(version)}:files`,
  );

  if (listed === undefined || listed === "failed") {
    return (
      <div className="flex-1 bg-panel p-6">
        {listed === "failed" ? (
          <ErrorText>
            The files didn&apos;t load. Check your connection and try again.
          </ErrorText>
        ) : (
          <p className="text-fg-dim">Loading…</p>
        )}
      </div>
    );
  }

  const files: readonly Row[] = [
    ...listed.files.filter(({ path }) => path === listed.entry),
    ...listed.files.filter(({ path }) => path !== listed.entry),
    ...listed.removed.map((path): Row => ({
      path,
      size: 0,
      change: "removed",
      lines: null,
    })),
  ];

  const shown =
    files.find(({ path }) => path === picked) ??
    files.find(({ change }) => change === "edited") ??
    files.find(({ change }) => change === "added") ??
    files[0];

  const number = versionOf(artifact, version);
  const save = number === null ? "this edit" : `version ${String(number)}`;
  const note = artifact.history[version - 1];

  return (
    <div className="flex min-h-0 flex-1 bg-panel max-sm:flex-col">
      <nav
        aria-label="Files"
        className="flex w-75 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-elevated px-3 py-3.5 max-sm:max-h-[40%] max-sm:w-full max-sm:border-r-0 max-sm:border-b"
      >
        <h3 className="px-2 py-1 text-label font-medium text-fg-dim">
          In {save}
        </h3>
        {files.map((file) => (
          <button
            key={file.path}
            type="button"
            aria-label={`${file.path}${file.path === listed.entry ? ", entry file" : ""}${changeOf(file)[1]}`}
            aria-current={file.path === shown?.path ? "true" : undefined}
            className={buttonClass({
              variant: "ghost",
              size: "sm",
              className:
                "w-full shrink-0 justify-start font-mono text-mono-sm aria-current:bg-hover aria-current:text-fg",
            })}
            onClick={() => {
              setPicked(file.path);
            }}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {file.path}
            </span>
            <Change file={file} entry={file.path === listed.entry} />
          </button>
        ))}
        <div className="my-2.5 h-px shrink-0 bg-line" />
        <h3 className="px-2 py-1 text-label font-medium text-fg-dim">
          {save.charAt(0).toUpperCase()}
          {save.slice(1)} changed
        </h3>
        <p className="px-2 text-caption leading-relaxed text-fg-dim">
          {changedLine(listed)}
          {note !== undefined &&
            note.note !== "" &&
            ` ${note.author.startsWith("session:") ? `“${note.note}”` : note.note}`}
        </p>
        <div className="mt-auto flex shrink-0 flex-col gap-1 rounded-[10px] border border-line p-2.5 max-sm:hidden">
          <span className="text-label font-medium text-fg-strong">Limits</span>
          <span className="text-caption text-fg-dim">
            Up to {maxFiles} files and {bytes(listed.maxBytes)} per version. The
            same file in two versions is stored once.
          </span>
        </div>
      </nav>
      {shown !== undefined && (
        <FileText
          key={shown.path}
          artifact={artifact}
          version={version}
          file={shown}
          how={how}
          onHow={setHow}
        />
      )}
    </div>
  );
}

// What the version did to a file, as its tag shows it and in words.
function changeOf({
  change,
  lines,
}: Row): readonly [string | undefined, string] {
  if (change === "same") {
    return [undefined, ""];
  }

  if (change === "added") {
    return ["new", ", new"];
  }

  if (change === "removed") {
    return ["removed", ", removed"];
  }

  return lines === null
    ? ["edited", ", edited"]
    : [
        `+${String(lines.added)} −${String(lines.removed)}`,
        `, ${String(lines.added)} ${lines.added === 1 ? "line" : "lines"} added, ${String(lines.removed)} removed`,
      ];
}

// The tags a row shows; its name says them in words.
function Change({
  file,
  entry,
}: {
  readonly file: Row;
  readonly entry: boolean;
}): ReactElement {
  const tag =
    "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-caption font-medium";

  const [seen] = changeOf(file);

  return (
    <>
      {entry && (
        <span aria-hidden className={cn(tag, "bg-hover text-fg-dim")}>
          entry
        </span>
      )}
      {seen !== undefined && (
        <span
          aria-hidden
          className={cn(
            tag,
            file.change === "added" && "bg-done-tint text-done",
            file.change === "removed" && "bg-failed/15 text-failed",
            file.change === "edited" && "bg-butter/30 text-fg",
          )}
        >
          {seen}
        </span>
      )}
    </>
  );
}

// 1 file edited, 1 added, 2 the same.
function changedLine({
  files,
  removed,
}: Pick<VersionFiles, "files" | "removed">): string {
  const count = (change: VersionFile["change"]): number =>
    files.filter((each) => each.change === change).length;

  const parts = (
    [
      [count("edited"), "edited"],
      [count("added"), "added"],
      [removed.length, "removed"],
      [count("same"), "the same"],
    ] as const
  ).filter(([n]) => n > 0);

  return `${parts
    .map(([n, what], at) =>
      at === 0
        ? `${String(n)} ${n === 1 ? "file" : "files"} ${what}`
        : `${String(n)} ${what}`,
    )
    .join(", ")}.`;
}

function FileText({
  artifact,
  version,
  file,
  how,
  onHow,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly file: Row;
  readonly how: How;
  readonly onHow: (how: How) => void;
}): ReactElement {
  const text = textFile(file.path);
  const picture = previewKind(file.path) === "image";
  // Only a file the version added or edited has changes to tell apart
  // from its whole text.
  const toggled = text && (file.change === "added" || file.change === "edited");

  return (
    <section
      aria-label={file.path}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex min-h-13.5 items-center gap-2 border-b border-line bg-elevated px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-label font-medium text-fg-strong">
          {file.path}
        </span>
        {toggled && (
          <Segmented
            label="Show"
            value={how}
            options={[
              { value: "changes", label: "Changes" },
              { value: "whole", label: "Whole file" },
            ]}
            onChange={onHow}
          />
        )}
      </div>
      {text && (
        <TextLines
          artifact={artifact}
          version={version}
          file={file}
          whole={how === "whole" || !toggled}
        />
      )}
      {!text && picture && file.change !== "removed" && (
        <Picture artifact={artifact} version={version} path={file.path} />
      )}
      {!text && (!picture || file.change === "removed") && (
        <p className="flex-1 bg-panel p-6 text-fg-dim">
          {file.change === "removed"
            ? `${file.path} was removed in this version.`
            : `${file.path} isn't text, so it isn't shown here. It's ${bytes(file.size)}, in the .zip.`}
        </p>
      )}
    </section>
  );
}

const as = (kind: DiffLine["kind"], text: string): readonly DiffLine[] =>
  text.split("\n").map((line) => ({ kind, text: line }));

// A whole file added or taken out, without the empty line after its last
// newline.
const all = (kind: "added" | "removed", text: string): readonly DiffLine[] =>
  as(kind, text.endsWith("\n") ? text.slice(0, -1) : text);

// A text file's lines: what the version changed in it, or all of it. Both
// come from the one read of each side.
function TextLines({
  artifact,
  version,
  file,
  whole,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly file: Row;
  readonly whole: boolean;
}): ReactElement {
  const { value: read } = useLoaded(
    async (): Promise<{ before: string; after: string } | "failed"> => {
      const at = async (number: number): Promise<string> =>
        fetched(artifact.id, number, "download", file.path);

      try {
        const after = file.change === "removed" ? "" : await at(version);

        const unchanged = file.change === "same" ? after : undefined;

        const before =
          file.change === "added" ? "" : (unchanged ?? (await at(version - 1)));

        return { before, after };
      } catch {
        return "failed";
      }
    },
    `${artifact.id}:${String(version)}:${file.path}`,
  );

  const lines = useMemo(():
    readonly DiffLine[] | "long" | "failed" | undefined => {
    if (read === undefined || read === "failed") {
      return read;
    }

    if (file.change === "removed") {
      return all("removed", read.before);
    }

    if (whole) {
      return as("same", read.after);
    }

    return file.change === "added"
      ? all("added", read.after)
      : (lineDiff(read.before, read.after) ?? "long");
  }, [read, whole, file.change]);

  return (
    <DiffView
      lines={lines}
      words={{
        label: whole && file.change !== "removed" ? "Whole file" : "Changes",
        long: "Too many changes to show here. Pick Whole file or download the .zip.",
        failed: `${file.path} didn't load. Try again.`,
      }}
    />
  );
}

// A picture of the folder, drawn from its bytes.
function Picture({
  artifact,
  version,
  path,
}: {
  readonly artifact: ArtifactView;
  readonly version: number;
  readonly path: string;
}): ReactElement {
  const { value: drawn } = useLoaded(
    async (): Promise<string> => {
      try {
        return URL.createObjectURL(
          new Blob(
            [await fetchedBytes(artifact.id, version, "download", path)],
            { type: mimeOf(path) },
          ),
        );
      } catch {
        return "failed";
      }
    },
    `${artifact.id}:${String(version)}:${path}:picture`,
  );

  useEffect(
    () => () => {
      if (drawn !== undefined && drawn !== "failed") {
        URL.revokeObjectURL(drawn);
      }
    },
    [drawn],
  );

  if (drawn === undefined || drawn === "failed") {
    return (
      <p className="flex-1 bg-panel p-6 text-fg-dim">
        {drawn === "failed" ? `${path} didn't load. Try again.` : "Loading…"}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-panel p-6">
      <img src={drawn} alt={path} className="max-h-full max-w-full" />
    </div>
  );
}
