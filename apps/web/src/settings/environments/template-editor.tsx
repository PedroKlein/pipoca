import type { EnvironmentTemplate } from "@pipoca/protocol";
import {
  Button,
  Field,
  type KeyValue,
  KeyValues,
  Select,
  TextArea,
  TextInput,
  useConfirm,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";
import { PluginBoundary } from "../../plugin-boundary";
import { enabledPlugins } from "../../plugins";

export function TemplateEditor({
  template,
  onChange,
}: {
  readonly template: EnvironmentTemplate;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [ask, asking] = useConfirm();

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

    api("environmentTemplates.update", {
      params: { id: template.id },
      body: {
        name: text("name"),
        setupScript: text("setupScript"),
        isolation: text("isolation"),
        image: image === "" ? null : image,
        variables: Object.fromEntries(
          named.map(({ name, value }) => [name.trim(), value]),
        ),
      },
    }).then(() => {
      setError(undefined);
      setSaved(true);
      onChange();
    }, failed);
  };

  const remove = (): void => {
    void ask({
      title: `Delete ${template.name}?`,
      description: `Environments made from ${template.name} keep running with their own settings.`,
      confirm: "Delete",
      danger: true,
    }).then((yes) => {
      if (yes) {
        api("environmentTemplates.remove", {
          params: { id: template.id },
        }).then(onChange, failed);
      }
    });
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
          <TextInput name="name" required defaultValue={template.name} />
        </Field>
        <Field label="Setup script, run once per machine or image before its first Session">
          <TextArea
            name="setupScript"
            rows={4}
            defaultValue={template.setupScript}
            placeholder="apt-get install -y ripgrep"
            className="min-h-24 resize-y font-mono text-mono-sm"
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
          <TextInput
            name="image"
            defaultValue={template.image ?? ""}
            placeholder="node:22-bookworm"
            className="font-mono"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          {template.source ? (
            <Button
              onClick={() => {
                api("environmentTemplates.syncs.create", {
                  params: { id: template.id },
                }).then(onChange, failed);
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
                <TemplateSection template={template} />
              </PluginBoundary>
            ),
        )}
      </div>
      {asking}
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
