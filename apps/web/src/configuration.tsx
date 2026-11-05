import {
  Badge,
  Button,
  cardClass,
  cn,
  ErrorText,
  Icon,
  PageTitle,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import { api, send } from "./api";
import { settingsPageClass } from "./page-class";

interface ConfigEntry {
  readonly name: string;
  readonly locked: boolean;
}

interface ConfigText extends ConfigEntry {
  readonly text: string;
  readonly version: string | null;
}

interface ConfigList {
  readonly root: string;
  readonly files: readonly ConfigEntry[];
}

// The config files every Settings page reads and writes, for admins who'd
// rather edit them whole (ADR 0039, ADR 0063).
export function ConfigurationPage(): ReactElement {
  const [list, setList] = useState<ConfigList>();
  const [chosen, setChosen] = useState("pipoca.json");
  const [folders, setFolders] = useState<ReadonlySet<string>>(new Set());
  const [file, setFile] = useState<ConfigText>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [ask, asking] = useConfirm();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const opened = (view: ConfigText): void => {
    const text = view.name.endsWith(".json") ? pretty(view.text) : view.text;

    setFile({ ...view, text });
    setDraft(text);
    setError(undefined);
  };

  useEffect(() => {
    api("/api/config")
      .then(async (response) => (await response.json()) as ConfigList)
      .then(setList, failed);
  }, []);

  useEffect(() => {
    api(`/api/config/file?name=${encodeURIComponent(chosen)}`)
      .then(async (response) => (await response.json()) as ConfigText)
      .then(opened, failed);
  }, [chosen]);

  const edited = file !== undefined && draft !== file.text;

  const invalid = chosen.endsWith(".json")
    ? jsonError(draft, chosen === "pipoca.json")
    : undefined;

  const choose = (name: string): void => {
    if (name === chosen) {
      return;
    }

    const discard = edited
      ? ask({
          title: `Discard your changes to ${chosen}?`,
          confirm: "Discard",
          danger: true,
        })
      : Promise.resolve(true);

    void discard.then((yes) => {
      if (yes) {
        setChosen(name);
      }
    });
  };

  const download = (): void => {
    const link = document.createElement("a");

    link.href = URL.createObjectURL(
      new Blob([file?.text ?? ""], { type: "text/plain" }),
    );

    link.download = chosen.split("/").at(-1) ?? chosen;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className={settingsPageClass}>
      <PageTitle
        description="Every page in Settings reads and writes these files. Edit them here, keep them in git, or let Helm write them."
        actions={
          <span className="flex items-center gap-3">
            <span className="font-mono text-mono-sm text-fg-dim">
              {list?.root}
            </span>
            <Button onClick={download} disabled={file === undefined}>
              Download
            </Button>
          </span>
        }
      >
        Configuration
      </PageTitle>
      <div className="mt-6 grid gap-4 md:grid-cols-[15rem_1fr]">
        <nav
          aria-label="Config files"
          className={cn(cardClass, "self-start p-2")}
        >
          <ul className="flex flex-col">
            {shownOf(treeOf(list?.files ?? []), folders).map((item) =>
              item.kind === "folder" ? (
                <li key={`folder:${item.path}`}>
                  <button
                    type="button"
                    aria-expanded={folders.has(item.path)}
                    onClick={() => {
                      setFolders((open) => toggled(open, item.path));
                    }}
                    style={{ paddingLeft: `${String(0.625 + item.depth)}rem` }}
                    className="flex w-full cursor-pointer items-center rounded-md py-1.5 pr-2.5 text-left font-mono text-mono-sm text-fg-muted hover:bg-hover"
                  >
                    {item.name}/
                  </button>
                </li>
              ) : (
                <li key={item.entry.name}>
                  <button
                    type="button"
                    aria-current={item.entry.name === chosen}
                    onClick={() => {
                      choose(item.entry.name);
                    }}
                    style={{ paddingLeft: `${String(0.625 + item.depth)}rem` }}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2.5 text-left font-mono text-mono-sm text-fg hover:bg-hover",
                      item.entry.name === chosen && "bg-hover text-fg-strong",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                    </span>
                    {item.entry.name === chosen && edited && (
                      <Badge state="waiting">Edited</Badge>
                    )}
                    {item.entry.locked && (
                      <span aria-label="Read-only" className="text-fg-dim">
                        <Icon name="lock" />
                      </span>
                    )}
                  </button>
                </li>
              ),
            )}
          </ul>
        </nav>
        <section
          aria-label={chosen}
          className={cn(
            cardClass,
            "flex min-w-0 flex-col self-start overflow-hidden",
          )}
        >
          <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="truncate font-mono text-mono-sm text-fg-strong">
              {chosen}
            </span>
            {invalid === undefined ? (
              chosen.endsWith(".json") && <Badge state="done">Valid</Badge>
            ) : (
              <Badge state="failed">Not valid JSON</Badge>
            )}
            {file?.locked === true ? (
              <span className="ml-auto text-label text-fg-dim">
                Read-only: change it where it&apos;s written, such as the Helm
                chart
              </span>
            ) : (
              <span className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  disabled={!edited}
                  onClick={() => {
                    setDraft(file?.text ?? "");
                    setError(undefined);
                  }}
                >
                  Discard
                </Button>
                <Button
                  variant="primary"
                  disabled={!edited || invalid !== undefined}
                  onClick={() => {
                    send("/api/config/file", "PUT", {
                      name: chosen,
                      text: draft,
                      version: file?.version ?? null,
                    })
                      .then(
                        async (response) =>
                          (await response.json()) as ConfigText,
                      )
                      .then(opened, failed);
                  }}
                >
                  Save
                </Button>
              </span>
            )}
          </header>
          <textarea
            aria-label={`${chosen} contents`}
            value={draft}
            readOnly={file?.locked === true}
            spellCheck={false}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="min-h-110 resize-y bg-hover px-4 py-3 font-mono text-mono-sm text-fg outline-none"
          />
          <footer className="flex flex-col gap-1 border-t border-line px-4 py-2.5 text-caption text-fg-dim">
            {(error ?? invalid) !== undefined && (
              <ErrorText size="inherit">{error ?? invalid}</ErrorText>
            )}
            <p>
              Secrets never appear here in plain text: they&apos;re sealed on
              the server or read from an environment variable.
            </p>
          </footer>
        </section>
      </div>
      {asking}
    </div>
  );
}

type TreeItem =
  | {
      readonly kind: "folder";
      readonly name: string;
      readonly path: string;
      readonly depth: number;
    }
  | {
      readonly kind: "file";
      readonly entry: ConfigEntry;
      readonly label: string;
      readonly depth: number;
    };

// Files come sorted, so a folder's heading goes before its first file. A
// file outside the folder, such as the locked one, keeps its whole path.
function treeOf(files: readonly ConfigEntry[]): readonly TreeItem[] {
  const shown = new Set<string>();

  return files.flatMap((entry): TreeItem[] => {
    if (entry.name.startsWith("/")) {
      return [{ kind: "file", entry, label: entry.name, depth: 0 }];
    }

    const parts = entry.name.split("/");

    const folders = parts.slice(0, -1).flatMap((name, depth): TreeItem[] => {
      const path = parts.slice(0, depth + 1).join("/");

      if (shown.has(path)) {
        return [];
      }

      shown.add(path);

      return [{ kind: "folder", name, path, depth }];
    });

    return [
      ...folders,
      {
        kind: "file",
        entry,
        label: parts.at(-1) ?? entry.name,
        depth: parts.length - 1,
      },
    ];
  });
}

// Folders start closed, so only a file whose folders are all open shows.
function shownOf(
  items: readonly TreeItem[],
  open: ReadonlySet<string>,
): readonly TreeItem[] {
  return items.filter((item) => {
    const name = item.kind === "folder" ? item.path : item.entry.name;

    if (name.startsWith("/")) {
      return true;
    }

    const parts = name.split("/");

    return parts
      .slice(0, -1)
      .every((_, depth) => open.has(parts.slice(0, depth + 1).join("/")));
  });
}

function toggled(open: ReadonlySet<string>, path: string): ReadonlySet<string> {
  const next = new Set(open);

  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }

  return next;
}

function jsonError(text: string, keyPerPlugin: boolean): string | undefined {
  try {
    const value: unknown = JSON.parse(text);

    return !keyPerPlugin ||
      (typeof value === "object" && value !== null && !Array.isArray(value))
      ? undefined
      : "It must hold an object with a key per plugin.";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A file written by hand or by a tool can be on one line.
function pretty(text: string): string {
  try {
    return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
  } catch {
    return text;
  }
}
