import type { EnvironmentTemplate, ManifestEntry } from "@pipoca/protocol";
import {
  Button,
  cn,
  Field,
  fieldClass,
  KeyValues,
  Section,
  Select,
  type KeyValue,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api, send } from "./api";
import { PluginBoundary } from "./plugin-boundary";
import { enabledPlugins, pluginContext } from "./plugins";

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

    void api("/api/templates", { name: new FormData(form).get("name") })
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
          <input
            name="name"
            required
            aria-label="New template name"
            placeholder="Cluster pods"
            className={cn(fieldClass, "w-48")}
          />
          <Button type="submit">Create</Button>
          {error !== undefined && (
            <p role="alert" className="text-caption text-failed">
              {error}
            </p>
          )}
        </form>
      )}
      {templates.length > 0 && (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-elevated shadow-xs">
          {templates.map((template) => (
            <TemplateEditor
              key={template.id}
              template={template}
              onChange={onChange}
            />
          ))}
        </div>
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

    api("/api/templates/listed", { url: repository })
      .then(async (response) => {
        const { templates } = (await response.json()) as {
          readonly templates: readonly ManifestEntry[];
        };

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

    api("/api/templates/import", { url: listed.url, paths }).then(
      onImported,
      failed,
    );
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-elevated p-4 shadow-xs">
      <form
        onSubmit={list}
        aria-label="Templates from a repository"
        className="flex flex-wrap items-center gap-2"
      >
        <input
          name="url"
          required
          aria-label="Repository URL"
          placeholder="https://github.com/team/platform.git"
          className={cn(fieldClass, "min-w-64 flex-1")}
        />
        <Button type="submit">List templates</Button>
      </form>
      {listed && listed.templates.length > 0 && (
        <form onSubmit={bring} className="flex flex-col gap-2">
          <span className="text-label text-fg-dim">
            Each one you bring follows the repository from then on.
          </span>
          {listed.templates.map(({ name, path }) => (
            <label key={path} className="flex items-center gap-2 text-ui">
              <input type="checkbox" name="path" value={path} defaultChecked />
              {name}
              <span className="font-mono text-mono-sm text-fg-dim">{path}</span>
            </label>
          ))}
          <span>
            <Button variant="primary" type="submit">
              Bring them
            </Button>
          </span>
        </form>
      )}
      {error !== undefined && (
        <p role="alert" className="text-caption text-failed">
          {error}
        </p>
      )}
    </div>
  );
}

function TemplateEditor({
  template,
  onChange,
}: {
  readonly template: EnvironmentTemplate;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const [rows, setRows] = useState<readonly KeyValue[]>(() =>
    Object.entries(template.variables).map(([name, value]) => ({
      name,
      value,
      secret: false,
    })),
  );

  const failed = (reason: unknown): void => {
    setSaved(false);
    setError(reason instanceof Error ? reason.message : String(reason));
  };

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    const text = (name: string): string => {
      const value = form.get(name);

      return typeof value === "string" ? value : "";
    };

    const named = rows.filter(({ name }) => name.trim() !== "");
    if (named.some(({ secret }) => secret)) {
      failed(
        new Error(
          "A template holds no secrets. Set them on each Environment instead.",
        ),
      );

      return;
    }

    const image = text("image").trim();

    send(`/api/templates/${template.id}`, "PATCH", {
      name: text("name"),
      setupScript: text("setupScript"),
      isolation: text("isolation"),
      image: image === "" ? null : image,
      variables: Object.fromEntries(
        named.map(({ name, value }) => [name.trim(), value]),
      ),
    }).then(() => {
      setError(undefined);
      setSaved(true);
      onChange();
    }, failed);
  };

  const remove = (): void => {
    if (
      !confirm(
        `Environments made from ${template.name} keep running with their own settings.`,
      )
    ) {
      return;
    }

    send(`/api/templates/${template.id}`, "DELETE").then(onChange, failed);
  };

  return (
    <details>
      <summary className="flex cursor-pointer list-none flex-col gap-0.5 px-4 py-3 hover:bg-hover">
        <span className="text-ui font-medium text-fg-strong">
          {template.name}
        </span>
        <span className="text-label text-fg-dim">{summaryOf(template)}</span>
      </summary>
      {template.source && (
        <p className="mx-5 mb-4 rounded-lg bg-hover p-3.5 text-label text-fg">
          Follows <span className="font-mono">{template.source.path}</span> in{" "}
          <span className="font-mono break-all">{template.source.url}</span> at{" "}
          <span className="font-mono">
            {template.source.commit.slice(0, 7)}
          </span>
          . Change it in the repository.
        </p>
      )}
      <form
        onSubmit={save}
        aria-label={`Template ${template.name}`}
        className="flex flex-col gap-4 px-5 pb-5"
      >
        <Field label="Name">
          <input
            name="name"
            required
            defaultValue={template.name}
            className={fieldClass}
          />
        </Field>
        <Field label="Setup script, run once per machine or image before its first Session">
          <textarea
            name="setupScript"
            rows={4}
            defaultValue={template.setupScript}
            placeholder="apt-get install -y ripgrep"
            className={cn(
              fieldClass,
              "min-h-24 resize-y font-mono text-mono-sm",
            )}
          />
        </Field>
        <KeyValues
          label="Variables, under each Environment's own"
          rows={rows}
          onChange={setRows}
        />
        <Field label="Run each Session">
          <Select name="isolation" defaultValue={template.isolation}>
            <option value="process">As a process on its machine</option>
            <option value="container">In a container (needs Docker)</option>
          </Select>
        </Field>
        <Field label="Container image, empty for the default">
          <input
            name="image"
            defaultValue={template.image ?? ""}
            placeholder="node:22-bookworm"
            className={cn(fieldClass, "font-mono")}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {template.source ? (
            <Button
              onClick={() => {
                api(`/api/templates/${template.id}/sync`, {}).then(
                  onChange,
                  failed,
                );
              }}
            >
              Sync now
            </Button>
          ) : (
            <Button variant="primary" type="submit">
              Save
            </Button>
          )}
          <Button onClick={remove}>Delete</Button>
          <p role="status" className="text-caption">
            {error !== undefined ? (
              <span className="text-failed">{error}</span>
            ) : (
              saved && <span className="text-fg-dim">Saved</span>
            )}
          </p>
        </div>
      </form>
      <div className="flex flex-col gap-4 px-5 pb-5">
        {enabledPlugins().map(
          ({ name, TemplateSection }) =>
            TemplateSection && (
              <PluginBoundary key={name} name={name}>
                <TemplateSection
                  context={pluginContext(name)}
                  template={template}
                />
              </PluginBoundary>
            ),
        )}
      </div>
    </details>
  );
}

function summaryOf(template: EnvironmentTemplate): string {
  const variables = Object.keys(template.variables).length;

  return [
    template.source && "follows its repository",
    template.isolation === "container"
      ? (template.image ?? "the default image")
      : "on the machine",
    template.setupScript.trim() !== "" && "a setup script",
    variables > 0 &&
      `${String(variables)} shared variable${variables === 1 ? "" : "s"}`,
  ]
    .filter(Boolean)
    .join(" · ");
}
