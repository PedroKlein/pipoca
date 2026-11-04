import { Badge, Button, PageTitle } from "@pipoca/ui";
import { type ReactElement, useEffect, useState } from "react";
import { api, send } from "./api";
import { settingsPageClass } from "./page-class";

interface ConfigView {
  readonly path: string;
  readonly text: string;
  readonly version: string | null;
}

// The config file every Settings page reads and writes, for admins who'd
// rather edit it whole (ADR 0039, ADR 0063).
export function ConfigurationPage(): ReactElement {
  const [file, setFile] = useState<ConfigView>();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const opened = (view: ConfigView): void => {
    const text = pretty(view.text);

    setFile({ ...view, text });
    setDraft(text);
    setError(undefined);
  };

  const load = (): void => {
    api("/api/config")
      .then(async (response) => (await response.json()) as ConfigView)
      .then(opened, failed);
  };

  useEffect(load, []);

  const edited = file !== undefined && draft !== file.text;
  const invalid = jsonError(draft);

  const download = (): void => {
    const link = document.createElement("a");

    link.href = URL.createObjectURL(
      new Blob([file?.text ?? ""], { type: "application/json" }),
    );

    link.download = "pipoca.json";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className={settingsPageClass}>
      <PageTitle
        description="Every page in Settings reads and writes this file. Edit it here, keep it in git, or let Helm write it."
        actions={
          <span className="flex items-center gap-3">
            <span className="font-mono text-mono-sm text-fg-dim">
              {file?.path}
            </span>
            <Button onClick={download} disabled={file === undefined}>
              Download
            </Button>
          </span>
        }
      >
        Configuration
      </PageTitle>
      <section
        aria-label="pipoca.json"
        className="mt-6 flex flex-col overflow-hidden rounded-lg border border-line bg-elevated shadow-xs"
      >
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-mono text-mono-sm text-fg-strong">
            pipoca.json
          </span>
          {invalid === undefined ? (
            <Badge state="done">Valid</Badge>
          ) : (
            <Badge state="failed">Not valid JSON</Badge>
          )}
          {edited && <Badge state="waiting">Edited</Badge>}
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
                send("/api/config", "PUT", {
                  text: draft,
                  version: file?.version ?? null,
                })
                  .then(
                    async (response) => (await response.json()) as ConfigView,
                  )
                  .then(opened, failed);
              }}
            >
              Save
            </Button>
          </span>
        </header>
        <textarea
          aria-label="pipoca.json contents"
          value={draft}
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          className="min-h-110 resize-y bg-hover px-4 py-3 font-mono text-mono-sm text-fg outline-none"
        />
        <footer className="flex flex-col gap-1 border-t border-line px-4 py-2.5 text-caption text-fg-dim">
          {(error ?? invalid) !== undefined && (
            <p role="alert" className="text-failed">
              {error ?? invalid}
            </p>
          )}
          <p>
            Secrets never appear here in plain text: they&apos;re sealed on the
            server or read from an environment variable.
          </p>
        </footer>
      </section>
    </div>
  );
}

function jsonError(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);

    return typeof value === "object" && value !== null && !Array.isArray(value)
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
