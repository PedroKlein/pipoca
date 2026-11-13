import {
  modelRefOf,
  type ProfileContent,
  thinkingLevels,
} from "@pipoca/protocol";
import { Button, Picker, Row, Rows, Section } from "@pipoca/ui";
import type { ReactElement } from "react";
import { useQuery } from "../../data/hooks";
import { ModelField, pickerModels } from "@pipoca/plugins/web";
import { SourceTag } from "./inherited";
import type { StackLayer } from "./stack";

type Settings = ProfileContent["settings"];

// One of Pi's settings a layer may set, the nearest layer's value winning.
interface Default {
  readonly title: string;
  readonly keys: readonly string[];
  readonly valueOf: (settings: Settings) => string | undefined;
}

const model: Default = {
  title: "Model",
  keys: ["defaultProvider", "defaultModel"],
  valueOf: (settings) =>
    typeof settings["defaultProvider"] === "string" &&
    typeof settings["defaultModel"] === "string"
      ? `${settings["defaultProvider"]}/${settings["defaultModel"]}`
      : undefined,
};

const thinking: Default = {
  title: "Thinking",
  keys: ["defaultThinkingLevel"],
  valueOf: (settings) =>
    typeof settings["defaultThinkingLevel"] === "string"
      ? settings["defaultThinkingLevel"]
      : undefined,
};

// The model and thinking level new Sessions start with, from the nearest
// layer that sets them (ADR 0074).
export function Defaults({
  below,
  own,
  editable,
  onSave,
}: {
  // The layers under the open one, the Server base first.
  readonly below: readonly StackLayer[];
  readonly own: StackLayer;
  readonly editable: boolean;
  readonly onSave: (settings: Settings) => void;
}): ReactElement {
  const environments = useQuery("environments.list").data ?? [];
  const settings = own.content.settings;

  const models = pickerModels(
    environments.flatMap((environment) => environment.models),
  );

  const set = (setting: Default, values: readonly string[]): void => {
    const kept = Object.fromEntries(
      Object.entries(settings).filter(([key]) => !setting.keys.includes(key)),
    );

    onSave({
      ...kept,
      ...Object.fromEntries(
        setting.keys.flatMap((key, index) =>
          values[index] === undefined ? [] : [[key, values[index]]],
        ),
      ),
    });
  };

  const row = (setting: Default, picker: ReactElement): ReactElement => {
    const mine = setting.valueOf(settings);

    const inherited = below
      .flatMap((layer) => {
        const value = setting.valueOf(layer.content.settings);

        return value === undefined ? [] : [{ layer, value }];
      })
      .at(-1);

    const description =
      mine !== undefined && inherited !== undefined ? (
        <>
          {mine} · replaces{" "}
          <s>
            {inherited.value} from {inherited.layer.name}
          </s>
        </>
      ) : (
        (mine ?? inherited?.value ?? "Pi's own default")
      );

    return (
      <Row title={setting.title} description={description}>
        {mine !== undefined && below.length > 0 && (
          <SourceTag name={own.name} kind="own" />
        )}
        {mine === undefined && inherited && (
          <SourceTag name={inherited.layer.name} kind={inherited.layer.kind} />
        )}
        {editable && picker}
        {editable && mine !== undefined && (
          <Button
            variant="ghost"
            onClick={() => {
              set(setting, []);
            }}
          >
            {below.length > 0 ? "Reset" : "Clear"}
          </Button>
        )}
      </Row>
    );
  };

  const setLabel = below.length > 0 ? `Set for ${own.name}` : "Set";

  return (
    <Section
      title="Defaults"
      description={
        below.length > 0
          ? "The nearest value wins"
          : "Starting values a Profile can change"
      }
    >
      <Rows label="Defaults">
        {row(
          model,
          <ModelField
            label={`${model.title} for ${own.name}`}
            quiet
            models={models}
            selected={model.valueOf(settings) ?? ""}
            create
            onPick={(name) => {
              const picked = modelRefOf(name);

              if (picked) {
                set(model, [picked.provider, picked.id]);
              }
            }}
          >
            {setLabel}
          </ModelField>,
        )}
        {row(
          thinking,
          <Picker
            label={`${thinking.title} for ${own.name}`}
            quiet
            options={thinkingLevels.map((level) => ({
              value: level,
              label: level,
            }))}
            selected={[thinking.valueOf(settings) ?? ""]}
            onChange={([level]) => {
              if (level !== undefined) {
                set(thinking, [level]);
              }
            }}
          >
            {setLabel}
          </Picker>,
        )}
      </Rows>
    </Section>
  );
}
