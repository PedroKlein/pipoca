import { uploadBlob, useApi, useLoaded } from "@pipoca/plugins/web";
import {
  Badge,
  Button,
  Cell,
  ErrorText,
  FileButton,
  Section,
  Table,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, useState } from "react";
import { projects } from "../plugin";
import { bytes, type FolderFile, type FolderWrite } from "../src/model";

type Named<T> = T & { readonly by: string };

// A Project's folder, which every Session in it sees as project/ (ADR 0078).
// path is the Project's own, such as projects/<id>.
export function Folder({ path }: { readonly path: string }): ReactElement {
  const api = useApi(projects);

  const { value, reload } = useLoaded(
    async () =>
      Promise.all([
        api.get<{ files: Named<FolderFile>[]; perProjectBytes: number }>(
          `${path}/files`,
        ),
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
    setError(undefined);

    try {
      await api.delete(`${path}/file?path=${encodeURIComponent(name)}`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
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

  const crumbs = here.split("/").filter(Boolean);
  const compared = files.find((file) => file.path === comparing);

  return (
    <>
      <Section
        title="Folder"
        description="Every Session in the Project sees this folder as project/. It's pulled before each turn and pushed after. When two threads change one file in the same turn, both are kept: the later one as a conflict copy."
      >
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
          <TextInput
            type="search"
            aria-label="Search the folder"
            placeholder="Search the folder"
            className="min-w-0 flex-1"
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
            {words.length > 0 ? "Nothing matches." : "No files here yet."}
          </p>
        ) : (
          <Table
            label="Folder"
            columns={["Name", "Size", "Last written by", "When", ""]}
          >
            {folders.map((name) => (
              <tr key={`folder:${name}`}>
                <Cell colSpan={5}>
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
                <Cell>
                  <span className="flex flex-wrap items-center gap-2">
                    <a
                      href={fileHref(file.path)}
                      download={file.path.split("/").at(-1)}
                      className="font-mono text-mono text-accent hover:underline"
                    >
                      {words.length > 0
                        ? file.path
                        : file.path.slice(here.length)}
                    </a>
                    {conflicts.has(file.path) && (
                      <Badge state="waiting">conflict copy</Badge>
                    )}
                  </span>
                </Cell>
                <Cell>{bytes(file.size)}</Cell>
                <Cell>{file.by}</Cell>
                <Cell>{new Date(file.updatedAt).toLocaleString()}</Cell>
                <Cell className="text-right whitespace-nowrap">
                  {conflicts.has(file.path) && (
                    <Button
                      variant="ghost"
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
                  <Button
                    variant="ghost"
                    aria-label={`Remove ${file.path}`}
                    onClick={() => {
                      void remove(file.path);
                    }}
                  >
                    Remove
                  </Button>
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
            : `${bytes(total)} of ${bytes(limit)} used`}
        </p>
        <ErrorText size="caption" className="whitespace-pre-line">
          {error}
        </ErrorText>
      </Section>
      <Section
        title="Recent writes"
        description="Earlier versions of a file stay downloadable for a while."
      >
        {writes.length === 0 ? (
          <p className="text-fg-dim">Nothing written yet.</p>
        ) : (
          <ul
            aria-label="Recent writes"
            className="flex flex-col gap-1 text-label"
          >
            {writes.map((write) => (
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
                <span className="text-fg-dim">
                  {new Date(write.at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
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
