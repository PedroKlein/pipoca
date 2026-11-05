import type { PluginInfo, SettingSpec, SettingValue } from "@pipoca/protocol";
import {
  Button,
  Checkbox,
  Field,
  Select,
  TextArea,
  TextInput,
} from "@pipoca/ui";
import { type ReactElement, type SubmitEvent, useState } from "react";
import { api } from "../../api";
import { settingsOf } from "../../plugin-settings";

export function SettingsForm({
  plugin,
  settings,
  onChange,
}: {
  readonly plugin: PluginInfo;
  readonly settings: Readonly<Record<string, SettingSpec>>;
  readonly onChange: () => void;
}): ReactElement {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const submit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSaved(false);

    api("plugins.update", {
      params: { plugin: plugin.id },
      body: {
        settings: settingsOf(settings, new FormData(event.currentTarget)),
      },
    }).then(
      () => {
        setError(undefined);
        setSaved(true);
        onChange();
      },
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      aria-label={`${plugin.title} settings`}
      className="flex flex-col gap-4 rounded-md bg-panel p-4"
    >
      {Object.entries(settings).map(([name, spec]) => (
        <SettingField
          key={name}
          name={name}
          spec={spec}
          value={plugin.values[name] ?? spec.default}
        />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" type="submit">
          Save
        </Button>
        <p role="status" className="text-caption">
          {error !== undefined ? (
            <span className="text-failed">{error}</span>
          ) : (
            saved && <span className="text-fg-dim">Saved</span>
          )}
        </p>
      </div>
    </form>
  );
}

function SettingField({
  name,
  spec,
  value,
}: {
  readonly name: string;
  readonly spec: SettingSpec;
  readonly value: SettingValue;
}): ReactElement {
  const label =
    spec.description === undefined
      ? spec.title
      : `${spec.title}. ${spec.description}`;

  switch (spec.type) {
    case "boolean":
      return (
        <Checkbox name={name} defaultChecked={value === true} label={label} />
      );
    case "choice":
      return (
        <Field label={label}>
          <Select name={name} defaultValue={String(value)}>
            {spec.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "strings":
      return (
        <Field label={`${label} One per line.`}>
          <TextArea
            name={name}
            rows={3}
            defaultValue={Array.isArray(value) ? value.join("\n") : ""}
            className="min-h-20 resize-y font-mono text-mono-sm"
          />
        </Field>
      );
    case "number":
      return (
        <Field label={label}>
          <TextInput
            name={name}
            type="number"
            required
            step="any"
            defaultValue={String(value)}
            {...(spec.min !== undefined && { min: spec.min })}
            {...(spec.max !== undefined && { max: spec.max })}
            className="w-40"
          />
        </Field>
      );
    case "string":
      return (
        <Field label={label}>
          <TextInput name={name} defaultValue={String(value)} />
        </Field>
      );
  }
}
