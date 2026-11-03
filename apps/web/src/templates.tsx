import type { EnvironmentTemplate } from "@pipoca/protocol";
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
        <Button
          onClick={() => {
            setAdding(!adding);
          }}
        >
          New template
        </Button>
      }
    >
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
          <Button variant="primary" type="submit">
            Save
          </Button>
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
