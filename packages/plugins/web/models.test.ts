import { expect, test } from "bun:test";
import { pickerModels } from "./models";

test("lists each model once with the most its listings know, providers by readable name", () => {
  expect(
    pickerModels(
      [
        { provider: "sap-ai-core", id: "gpt-6.1" },
        { provider: "openai", id: "gpt-5-mini", name: "GPT-5 mini" },
        {
          provider: "sap-ai-core",
          id: "gpt-6.1",
          name: "GPT-6.1",
          contextWindow: 400_000,
        },
        { provider: "alias", id: "fast" },
      ],
      {
        hidden: ["openai/gpt-5-mini"],
        unavailable: [{ target: "sap-ai-core", reason: "quota exceeded" }],
      },
    ),
  ).toEqual([
    {
      value: "alias/fast",
      provider: "alias",
      providerName: "Aliases",
      id: "fast",
      name: undefined,
      contextWindow: undefined,
      reasoning: undefined,
      unavailable: undefined,
    },
    {
      value: "sap-ai-core/gpt-6.1",
      provider: "sap-ai-core",
      providerName: "SAP AI Core",
      id: "gpt-6.1",
      name: "GPT-6.1",
      contextWindow: 400_000,
      reasoning: undefined,
      unavailable: "quota exceeded",
    },
  ]);
});
