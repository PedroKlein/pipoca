import type { Environment, ModelInfo, ModelRef } from "@pipoca/protocol";
import { ModelField, pickerModels } from "@pipoca/plugins/web";
import type { ReactElement, RefObject } from "react";
import { modelName, modelRef } from "../../names";
import type { Settings } from "../feed";

// Claude Code's model menu with its effort levels, on Pi's model and
// reasoning level (ADR 0023).
export function ModelMenu({
  settings,
  models,
  hiddenModels,
  unavailableModels,
  modelMenu,
  onModel,
  onLogin,
  onThinking,
}: {
  readonly settings: Settings;
  readonly models: readonly ModelInfo[];
  readonly hiddenModels: readonly string[];
  readonly unavailableModels: Environment["unavailableModels"];
  readonly modelMenu: RefObject<HTMLButtonElement | null>;
  readonly onModel: (model: ModelRef) => void;
  // Team work runs on the team's keys and takes no logins.
  readonly onLogin?: (() => void) | undefined;
  readonly onThinking: (level: Settings["thinking"]) => void;
}): ReactElement {
  const current = settings.model ? modelName(settings.model) : "";

  const known = pickerModels(
    [
      ...models,
      ...settings.models,
      ...(settings.model ? [settings.model] : []),
    ],
    {
      hidden: hiddenModels.filter((name) => name !== current),
      unavailable: unavailableModels,
    },
  );

  const picked = known.find(({ value }) => value === current);

  return (
    <ModelField
      label="Model"
      quiet
      trigger={modelMenu}
      models={known}
      selected={current}
      {...(settings.levels.length > 1 && {
        reasoning: {
          levels: settings.levels.map((level) => ({
            value: level,
            label: level,
          })),
          value: settings.thinking,
          onChange: (level) => {
            const chosen = settings.levels.find((each) => each === level);

            if (chosen !== undefined) {
              onThinking(chosen);
            }
          },
        },
      })}
      onLogin={onLogin}
      onPick={(name) => {
        const model = modelRef(name);

        if (model) {
          onModel(model);
        }
      }}
    >
      {picked?.name ?? settings.model?.id ?? "Choose a model"}
      {settings.levels.length > 1 &&
        settings.thinking !== "off" &&
        ` · ${settings.thinking}`}
    </ModelField>
  );
}
