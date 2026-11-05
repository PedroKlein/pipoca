import type { ConfigFile } from "@pipoca/protocol";
import {
  Badge,
  Button,
  cardClass,
  cn,
  ErrorText,
  Icon,
  Page,
  PageTitle,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import { api } from "../../api";
import {
  type ConfigList,
  treeOf,
  shownOf,
  toggled,
  jsonError,
  pretty,
} from "./tree";

type ConfigText = ConfigFile;

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
    api("settings.config").then(setList, failed);
  }, []);

  useEffect(() => {
    api("settings.config.file", { params: { name: chosen } }).then(
      opened,
      failed,
    );
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
    <Page>
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
                    api("settings.config.file.write", {
                      params: { name: chosen },
                      body: { text: draft, version: file?.version ?? null },
                    }).then(opened, failed);
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
    </Page>
  );
}
