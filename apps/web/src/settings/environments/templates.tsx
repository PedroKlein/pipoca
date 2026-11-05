import type { EnvironmentTemplate, ManifestEntry } from "@pipoca/protocol";
import {
  Button,
  Card,
  Checkbox,
  ErrorText,
  Section,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";
import { TemplateEditor } from "./template-editor";

// What admins share for everyone's Environments (ADR 0049). The server
// answers anyone else's change with why it can't.
export function Templates({
  templates,
  onChange,
}: {
  readonly templates: readonly EnvironmentTemplate[];
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const create = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = event.currentTarget;

    const name = new FormData(form).get("name");

    void api("environmentTemplates.create", {
      body: { name: typeof name === "string" ? name : "" },
    })
      .then(() => {
        setError(undefined);
        form.reset();
        setAdding(false);
        onChange();
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  };

  return (
    <Section
      title="Templates"
      description="Ready-made Environments everyone on the server can use"
      actions={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setImporting(!importing);
            }}
          >
            From a repository
          </Button>
          <Button
            onClick={() => {
              setAdding(!adding);
            }}
          >
            New template
          </Button>
        </>
      }
    >
      {importing && (
        <FromRepository
          onImported={() => {
            setImporting(false);
            onChange();
          }}
        />
      )}
      {adding && (
        <form
          onSubmit={create}
          aria-label="New template"
          className="flex flex-wrap items-center gap-2"
        >
          <TextInput
            name="name"
            required
            aria-label="New template name"
            placeholder="Cluster pods"
            className="w-48"
          />
          <Button type="submit">Create</Button>
          <ErrorText size="caption">{error}</ErrorText>
        </form>
      )}
      {templates.length > 0 && (
        <Card padding="none" className="divide-y divide-line overflow-hidden">
          {templates.map((template) => (
            <TemplateEditor
              key={template.id}
              template={template}
              onChange={onChange}
            />
          ))}
        </Card>
      )}
    </Section>
  );
}

// Templates a repository's pipoca.json lists, which follow the repository
// once brought (ADR 0063).
function FromRepository({
  onImported,
}: {
  readonly onImported: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();

  const [listed, setListed] = useState<{
    readonly url: string;
    readonly templates: readonly ManifestEntry[];
  }>();

  const failed = (reason: unknown): void => {
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const list = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const url = new FormData(event.currentTarget).get("url");
    const repository = typeof url === "string" ? url.trim() : "";

    api("repositories.manifest", { query: { url: repository } })
      .then(({ templates }) => {
        setError(
          templates.length === 0
            ? "Its pipoca.json lists no templates."
            : undefined,
        );

        setListed({ url: repository, templates });
      })
      .catch(failed);
  };

  const bring = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!listed) {
      return;
    }

    const paths = new FormData(event.currentTarget).getAll("path");

    Promise.all(
      paths
        .flatMap((path) => (typeof path === "string" ? [path] : []))
        .map(async (path) =>
          api("environmentTemplates.create", {
            body: { source: { url: listed.url, path } },
          }),
        ),
    ).then(onImported, failed);
  };

  return (
    <Card padding="none" className="flex flex-col gap-3 p-4">
      <form
        onSubmit={list}
        aria-label="Templates from a repository"
        className="flex flex-wrap items-center gap-2"
      >
        <TextInput
          name="url"
          required
          aria-label="Repository URL"
          placeholder="https://github.com/team/platform.git"
          className="min-w-64 flex-1"
        />
        <Button type="submit">List templates</Button>
      </form>
      {listed && listed.templates.length > 0 && (
        <form onSubmit={bring} className="flex flex-col gap-2">
          <span className="text-label text-fg-dim">
            Each one you bring follows the repository from then on.
          </span>
          {listed.templates.map(({ name, path }) => (
            <Checkbox
              key={path}
              name="path"
              value={path}
              defaultChecked
              label={
                <>
                  {name}{" "}
                  <span className="font-mono text-mono-sm text-fg-dim">
                    {path}
                  </span>
                </>
              }
            />
          ))}
          <span>
            <Button variant="primary" type="submit">
              Bring them
            </Button>
          </span>
        </form>
      )}
      <ErrorText size="caption">{error}</ErrorText>
    </Card>
  );
}
