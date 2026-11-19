import { errorText } from "@pipoca/protocol";
import {
  ago,
  uploadBlob,
  useApi,
  useDraft,
  useFilled,
  useLoaded,
  useNow,
  useOverlay,
} from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Cell,
  ErrorText,
  FileButton,
  Menu,
  plural,
  SearchInput,
  Section,
  Table,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { folderAttachment, publishable } from "./files";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { projects } from "../plugin";
import { bytes, type FolderFile, type FolderWrite } from "../src/model";

type Named<T> = T & { readonly by: string };

// A Project's folder, which every Session in it sees as project/ (ADR 0078).
// A row opens the file in the viewer, and its More menu holds the rest
// (ADR 0081).
export function Folder({
  project,
}: {
  readonly project: {
    readonly id: string;
    readonly coordinatorId: string;
    readonly steers: boolean;
  };
}): ReactElement {
  const api = useApi(projects);
  const path = `projects/${encodeURIComponent(project.id)}`;
  const { open } = useOverlay();
  const draft = useDraft();
  const publishes = useFilled("file.actions");
  const time = useNow();
  const [confirm, confirmDialog] = useConfirm();

  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        api.get<{
          files: Named<FolderFile>[];
          perProjectBytes: number;
          historyDays: number;
        }>(`${path}/files`),
        api.get<{ writes: Named<FolderWrite>[] }>(`${path}/log`),
      ]),
    path,
    { changes: ["projects"] },
  );

  const files = value?.[0].files ?? [];
  const limit = value?.[0].perProjectBytes ?? Infinity;
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const writes = value?.[1].writes ?? [];

  const conflicts = new Set(
    writes.filter((each) => each.conflict).map((each) => each.path),
  );

  // The folder being looked at, such as "reports/", or "" for the top.
  const [here, setHere] = useState("");
  const [made, setMade] = useState<readonly string[]>([]);
  const [search, setSearch] = useState("");
  const [comparing, setComparing] = useState<string>();
  // The file whose earlier versions Recent writes shows.
  const [history, setHistory] = useState<string>();
  const versions = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (history !== undefined) {
      versions.current?.scrollIntoView({ block: "start" });
    }
  }, [history]);

  const [sending, setSending] = useState<ReadonlyMap<string, number>>(
    new Map(),
  );

  const [error, setError] = useState<string>();

  const fileHref = (name: string): string =>
    `/api/ext/projects/${path}/file?path=${encodeURIComponent(name)}`;

  const upload = async (chosen: readonly File[]): Promise<void> => {
    setError(undefined);

    const results = await Promise.allSettled(
      chosen.map(async (file) => {
        const hash = await uploadBlob(api, file, (sent) => {
          setSending((now) =>
            new Map(now).set(file.name, sent / (file.size || 1)),
          );
        });

        await api.post(`${path}/files`, { path: `${here}${file.name}`, hash });
      }),
    );

    setSending(new Map());
    reload();

    const failures = results.flatMap((result) =>
      result.status === "rejected"
        ? [
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
          ]
        : [],
    );

    if (failures.length > 0) {
      setError(failures.join("\n"));
    }
  };

  const remove = async (name: string): Promise<void> => {
    const yes = await confirm({
      title: `Delete ${name}?`,
      description: `Every Session in the Project loses it from project/. Earlier versions stay in Recent writes for ${plural(value?.[0].historyDays ?? 0, "day")}.`,
      confirm: "Delete",
      danger: true,
    });

    if (!yes) {
      return;
    }

    setError(undefined);

    try {
      await api.delete(`${path}/file?path=${encodeURIComponent(name)}`);
    } catch (problem) {
      setError(errorText(problem));
    }

    reload();
  };

  const words = search.toLowerCase().split(/\s+/).filter(Boolean);

  const found =
    words.length > 0
      ? files.filter((file) =>
          words.every((word) => file.path.toLowerCase().includes(word)),
        )
      : files.filter(
          (file) =>
            file.path.startsWith(here) &&
            !file.path.slice(here.length).includes("/"),
        );

  const folders =
    words.length > 0
      ? []
      : [
          ...new Set([
            ...files
              .filter((file) => file.path.startsWith(here))
              .map((file) => file.path.slice(here.length))
              .filter((rest) => rest.includes("/"))
              .map((rest) => rest.split("/")[0] ?? ""),
            ...made
              .filter((each) => each.startsWith(here))
              .map((each) => each.slice(here.length).split("/")[0] ?? ""),
          ]),
        ]
          .filter(Boolean)
          .sort();

  const listedWrites =
    history === undefined
      ? writes
      : writes.filter((each) => each.path === history);

  const crumbs = here.split("/").filter(Boolean);
  const compared = files.find((file) => file.path === comparing);

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <p className="text-label text-fg-dim">
          Every Session in the Project sees this folder as project/. When two
          Sessions change one file in the same turn, the later one is kept as a
          conflict copy.
        </p>
        <nav
          aria-label="Folder path"
          className="flex flex-wrap items-center gap-1 font-mono text-mono"
        >
          <button
            type="button"
            className="cursor-pointer text-accent hover:underline"
            onClick={() => {
              setHere("");
            }}
          >
            project
          </button>
          {crumbs.map((name, at) => (
            <span key={name} className="flex items-center gap-1">
              <span className="text-fg-dim">/</span>
              <button
                type="button"
                className="cursor-pointer text-accent hover:underline"
                onClick={() => {
                  setHere(`${crumbs.slice(0, at + 1).join("/")}/`);
                }}
              >
                {name}
              </button>
            </span>
          ))}
          <span className="text-fg-dim">/</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            aria-label="Search the folder"
            placeholder="Search the folder"
            className="flex-1"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <NewFolder
            onMade={(name) => {
              setMade([...made, `${here}${name}/`]);
              setHere(`${here}${name}/`);
            }}
          />
          <FileButton
            multiple
            aria-label="Upload files"
            onFiles={(picked) => {
              void upload(picked);
            }}
          >
            Upload
          </FileButton>
        </div>
        {found.length === 0 && folders.length === 0 ? (
          <p className="text-fg-dim">
            {words.length > 0
              ? "Nothing matches."
              : "No files here yet. Upload one, or ask Pi to save to project/."}
          </p>
        ) : (
          <Table label="Folder" minWidth={false} columns={["Name", "Size", ""]}>
            {folders.map((name) => (
              <tr key={`folder:${name}`}>
                <Cell colSpan={3}>
                  <button
                    type="button"
                    className="cursor-pointer font-mono text-mono text-accent hover:underline"
                    onClick={() => {
                      setHere(`${here}${name}/`);
                    }}
                  >
                    {`${name}/`}
                  </button>
                </Cell>
              </tr>
            ))}
            {found.map((file) => (
              <tr key={file.path}>
                <Cell className="max-w-0 w-full">
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      title={file.path}
                      className="min-w-0 cursor-pointer truncate text-left text-fg-strong hover:underline"
                      onClick={() => {
                        open({ project: project.id, path: file.path });
                      }}
                    >
                      {words.length > 0
                        ? file.path
                        : file.path.slice(here.length)}
                    </button>
                    {conflicts.has(file.path) && (
                      <Badge state="waiting">conflict copy</Badge>
                    )}
                  </span>
                  <span className="block truncate text-caption text-fg-dim">
                    {file.by} ·{" "}
                    {ago(new Date(file.updatedAt).toISOString(), time)}
                  </span>
                </Cell>
                <Cell className="whitespace-nowrap">{bytes(file.size)}</Cell>
                <Cell className="text-right whitespace-nowrap">
                  {conflicts.has(file.path) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={comparing === file.path}
                      onClick={() => {
                        setComparing(
                          comparing === file.path ? undefined : file.path,
                        );
                      }}
                    >
                      Compare
                    </Button>
                  )}
                  <Menu
                    label={`More for ${file.path}`}
                    icon="more"
                    size="sm"
                    align="end"
                    items={[
                      {
                        label: "Open",
                        run: () => {
                          open({ project: project.id, path: file.path });
                        },
                      },
                      {
                        label: "Download",
                        run: () => {
                          saveAs(fileHref(file.path), file.path);
                        },
                      },
                      // The file's viewer holds the publish button, which
                      // the artifacts plugin draws.
                      ...(publishes && project.steers && publishable(file.path)
                        ? [
                            {
                              label: "Publish as artifact…",
                              run: () => {
                                open({ project: project.id, path: file.path });
                              },
                            },
                          ]
                        : []),
                      {
                        label: "Attach to a new message",
                        run: () => {
                          draft(project.coordinatorId, "", [
                            folderAttachment(file.path),
                          ]);
                        },
                      },
                      {
                        label: "Earlier versions",
                        run: () => {
                          setHistory(file.path);
                        },
                      },
                      {
                        label: "Delete…",
                        danger: true,
                        divided: true,
                        run: () => {
                          void remove(file.path);
                        },
                      },
                    ]}
                  />
                </Cell>
              </tr>
            ))}
          </Table>
        )}
        {compared !== undefined && (
          <Compare
            copy={compared.path}
            original={originalOf(compared.path)}
            href={fileHref}
          />
        )}
        {[...sending].map(([name, part]) => (
          <p key={name} className="text-caption text-fg-dim">
            Uploading {name} {String(Math.floor(part * 100))}%
          </p>
        ))}
        <p
          className={
            total > limit
              ? "text-label text-waiting"
              : "text-caption text-fg-dim"
          }
        >
          {total > limit
            ? `The folder holds ${bytes(total)}, more than the ${bytes(limit)} this server suggests for a Project. Nothing is deleted or refused.`
            : `${plural(files.length, "file")} · ${bytes(total)} of ${bytes(limit)} used`}
        </p>
        <ErrorText size="caption" className="whitespace-pre-line">
          {error}
        </ErrorText>
      </div>
      <div ref={versions} />
      <Section
        title={
          history === undefined ? "Recent writes" : `Versions of ${history}`
        }
        description={`Earlier versions of a file stay downloadable for ${plural(value?.[0].historyDays ?? 0, "day")}.`}
      >
        {history !== undefined && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => {
              setHistory(undefined);
            }}
          >
            Show every file
          </Button>
        )}
        {listedWrites.length === 0 ? (
          <p className="text-fg-dim">Nothing written yet.</p>
        ) : (
          <ul
            aria-label="Recent writes"
            className="flex flex-col gap-1 text-label"
          >
            {listedWrites.map((write) => (
              <li key={write.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg-strong">{write.by}</span>
                <span>
                  {write.hash === null ? "removed" : "wrote"}{" "}
                  {write.hash === null ? (
                    write.path
                  ) : (
                    <a
                      href={`/api/ext/projects/${path}/log/${write.id}`}
                      download={write.path.split("/").at(-1)}
                      className="font-mono text-accent hover:underline"
                    >
                      {write.path}
                    </a>
                  )}
                  {write.hash !== null && ` (${bytes(write.size)})`}
                  {write.conflict && ", saved as a conflict copy"}
                </span>
                <span
                  className="text-fg-dim"
                  title={new Date(write.at).toLocaleString()}
                >
                  {ago(new Date(write.at).toISOString(), time)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
      {confirmDialog}
    </>
  );
}

function saveAs(href: string, path: string): void {
  const link = document.createElement("a");

  link.href = href;
  link.download = path.split("/").at(-1) ?? path;
  link.click();
}

// A folder exists once a file is in it; until then it's only where the next
// upload goes.
function NewFolder({
  onMade,
}: {
  readonly onMade: (name: string) => void;
}): ReactElement {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const clean = name.trim().replaceAll("/", " ").trim();

  if (!naming) {
    return (
      <Button
        variant="default"
        onClick={() => {
          setNaming(true);
        }}
      >
        New folder
      </Button>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (clean !== "") {
          onMade(clean);
        }

        setName("");
        setNaming(false);
      }}
    >
      <TextInput
        aria-label="Folder name"
        placeholder="Folder name"
        autoFocus
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <Button type="submit" variant="default" disabled={clean === ""}>
        Make
      </Button>
    </form>
  );
}

// "notes (from Fix login) (2).md" was saved beside "notes.md".
function originalOf(copy: string): string {
  return copy.replace(/ \(from [^)]*\)(?: \(\d+\))?(\.[^./]*)?$/u, "$1");
}

function Compare({
  copy,
  original,
  href,
}: {
  readonly copy: string;
  readonly original: string;
  readonly href: (name: string) => string;
}): ReactElement {
  const { value } = useLoaded(
    async () =>
      Promise.all(
        [original, copy].map(async (name) => {
          const response = await fetch(href(name));

          return response.ok ? response.text() : `${name} didn't load.`;
        }),
      ),
    `${original}:${copy}`,
  );

  return (
    <div aria-label="Compare" className="grid gap-3 md:grid-cols-2">
      {[original, copy].map((name, at) => (
        <div key={name} className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-caption text-fg-dim">{name}</span>
          <pre className="max-h-80 overflow-auto rounded-md border border-line p-3 font-mono text-mono whitespace-pre-wrap">
            {value?.[at] ?? ""}
          </pre>
        </div>
      ))}
    </div>
  );
}
