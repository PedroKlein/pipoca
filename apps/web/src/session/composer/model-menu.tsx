import { modelOptions, rememberModel, shownModels } from "../../models";
import type { ModelRef } from "@pipoca/protocol";
import { Picker, Slider } from "@pipoca/ui";
import type { ReactElement, RefObject } from "react";
import { modelName, modelRef } from "../../names";
import type { Settings } from "../feed";

// Claude Code's model menu with its effort levels, on Pi's model and reasoning level
// (ADR 0023).
export function ModelMenu({
  settings,
  models,
  hiddenModels,
  modelMenu,
  onModel,
  onLogin,
  onThinking,
}: {
  readonly settings: Settings;
  readonly models: readonly ModelRef[];
  readonly hiddenModels: readonly string[];
  readonly modelMenu: RefObject<HTMLButtonElement | null>;
  readonly onModel: (model: ModelRef) => void;
  readonly onLogin: () => void;
  readonly onThinking: (level: Settings["thinking"]) => void;
}): ReactElement {
  const current = settings.model ? modelName(settings.model) : "";

  const known = [
    ...new Map(
      shownModels(
        [
          ...(settings.model ? [settings.model] : []),
          ...models,
          ...settings.models,
        ],
        hiddenModels,
        settings.model,
      ).map((model) => [modelName(model), model] as const),
    ).values(),
  ];

  const { options, openGroups } = modelOptions(known);

  return (
    <Picker
      label="Model"
      quiet
      trigger={modelMenu}
      options={options}
      {...(openGroups && { openGroups })}
      selected={[current]}
      {...(known.length > 6 && { placeholder: "Search models" })}
      actions={[{ label: "Log in to a provider…", run: onLogin }]}
      {...(settings.levels.length > 1 && {
        footer: (
          <Slider
            label="Reasoning"
            stops={settings.levels.map((level) => ({
              value: level,
              label: level,
            }))}
            value={settings.thinking}
            onChange={onThinking}
          />
        ),
      })}
      onChange={([name]) => {
        const model = modelRef(name ?? "");

        if (model && name !== undefined) {
          rememberModel(name);
          onModel(model);
        }
      }}
    >
      {settings.model?.id ?? "Choose a model"}
      {settings.levels.length > 1 &&
        settings.thinking !== "off" &&
        ` · ${settings.thinking}`}
    </Picker>
  );
}
