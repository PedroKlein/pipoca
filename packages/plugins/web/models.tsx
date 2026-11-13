import {
  apiClient,
  type ModelChoices,
  type ModelInfo,
  modelName,
} from "@pipoca/protocol";
import { ModelPicker, type PickerModel } from "@pipoca/ui";
import { type ComponentProps, type ReactElement, useState } from "react";
import { useLoaded } from "./index";

const client = apiClient();

const noChoices: ModelChoices = { favorites: [], recent: [], hidden: [] };

// Names people know, where a provider's id doesn't spell it.
const providerNames: Readonly<Record<string, string>> = {
  alias: "Aliases",
  "github-copilot": "GitHub Copilot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  xai: "xAI",
  deepseek: "DeepSeek",
};

export function providerName(provider: string): string {
  return (
    providerNames[provider] ??
    provider
      .split(/[-_]/)
      .map((word) =>
        word.length <= 3
          ? word.toUpperCase()
          : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
      )
      .join(" ")
  );
}

// The models an Environment offers, as the picker lists them: providers in
// order, admin-hidden ones left out, and the ones that failed recently, alone
// or with their whole provider, with why.
export function pickerModels(
  models: readonly ModelInfo[],
  {
    hidden = [],
    unavailable = [],
  }: {
    readonly hidden?: readonly string[];
    readonly unavailable?: readonly {
      readonly target: string;
      readonly reason: string;
    }[];
  } = {},
): readonly PickerModel[] {
  const why = new Map(
    unavailable.map(({ target, reason }) => [target, reason]),
  );

  // One listing may know a model's name or size that another doesn't.
  const merged = new Map<string, ModelInfo>();

  for (const model of models) {
    const value = modelName(model);

    merged.set(value, { ...model, ...merged.get(value) });
  }

  return [...merged]
    .filter(([value]) => !hidden.includes(value))
    .sort(
      ([, a], [, b]) =>
        Number(b.provider === "alias") - Number(a.provider === "alias") ||
        a.provider.localeCompare(b.provider),
    )
    .map(([value, model]) => ({
      value,
      provider: model.provider,
      providerName: providerName(model.provider),
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      unavailable: why.get(value) ?? why.get(model.provider),
    }));
}

type FieldProps = Omit<
  ComponentProps<typeof ModelPicker>,
  "favorites" | "recent" | "hidden" | "onStar" | "onHide"
>;

// The model picker with the person's own stars, recent picks and hidden
// models, kept on the server.
export function ModelField(props: FieldProps): ReactElement {
  const loaded = useLoaded(
    async () => client("me.modelChoices"),
    "model-choices",
    {
      topics: ["model-choices"],
    },
  ).value;

  const [changed, setChanged] = useState<ModelChoices>();
  const choices = changed ?? loaded ?? noChoices;

  const save = (next: ModelChoices): void => {
    setChanged(next);

    // A failed save shows what the server keeps again.
    client("me.modelChoices.update", { body: next }).catch(() => {
      setChanged(undefined);
    });
  };

  return (
    <ModelPicker
      {...props}
      favorites={choices.favorites}
      recent={choices.recent}
      hidden={choices.hidden}
      onPick={(value) => {
        if (value !== "") {
          save({
            ...choices,
            recent: [
              value,
              ...choices.recent.filter((known) => known !== value),
            ],
          });
        }

        props.onPick(value);
      }}
      onStar={(value, starred) => {
        save({
          ...choices,
          favorites: starred
            ? [...choices.favorites, value]
            : choices.favorites.filter((known) => known !== value),
        });
      }}
      onHide={(hidden) => {
        save({ ...choices, hidden });
      }}
    />
  );
}
