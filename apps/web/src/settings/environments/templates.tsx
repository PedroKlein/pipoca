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
import { request } from "../../data/client";
import { useAction } from "../../data/hooks";
import { TemplateEditor } from "./template-editor";

const textOf = (form: HTMLFormElement, name: string): string => {
  const value = new FormData(form).get(name);

  return typeof value === "string" ? value.trim() : "";
};

// What admins share for everyone's Environments (ADR 0049). The server
// answers anyone else's change with why it can't.
export function Templates({
  templates,
}: {
  readonly templates: readonly EnvironmentTemplate[];
}): ReactElement {
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const create = useAction(async (form: HTMLFormElement) => {
    await request("environmentTemplates.create", {
      body: { name: textOf(form, "name") },
    });

    form.reset();
    setAdding(false);
  });

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
          }}
        />
      )}
      {adding && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void create.run(event.currentTarget);
          }}
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
          <ErrorText size="caption">{create.error}</ErrorText>
        </form>
      )}
      {templates.length > 0 && (
        <Card padding="none" className="divide-y divide-line overflow-hidden">
          {templates.map((template) => (
            <TemplateEditor key={template.id} template={template} />
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
  const [listed, setListed] = useState<{
    readonly url: string;
    readonly templates: readonly ManifestEntry[];
  }>();

  const list = useAction(async (url: string) => {
    const { templates } = await request("repositories.manifest", {
      query: { url },
    });

    setListed({ url, templates });
  });

  const bring = useAction(async (url: string, paths: readonly string[]) => {
    await Promise.all(
      paths.map(async (path) =>
        request("environmentTemplates.create", {
          body: { source: { url, path } },
        }),
      ),
    );

    onImported();
  });

  const submitBring = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();

    if (!listed) {
      return;
    }

    const paths = new FormData(event.currentTarget)
      .getAll("path")
      .flatMap((path) => (typeof path === "string" ? [path] : []));

    void bring.run(listed.url, paths);
  };

  const empty =
    listed?.templates.length === 0
      ? "Its pipoca.json lists no templates."
      : undefined;

  return (
    <Card padding="none" className="flex flex-col gap-3 p-4">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void list.run(textOf(event.currentTarget, "url"));
        }}
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
        <form onSubmit={submitBring} className="flex flex-col gap-2">
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
      <ErrorText size="caption">{list.error ?? bring.error ?? empty}</ErrorText>
    </Card>
  );
}
