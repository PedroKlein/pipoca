import { expect, test } from "bun:test";
import { ModelPicker, type PickerModel } from "./model-picker";
import { byRole, click, press, render, type, withPage } from "./testing/render";

withPage();

const models: readonly PickerModel[] = [
  {
    value: "sap-ai-core/anthropic--claude-4.6-sonnet",
    provider: "sap-ai-core",
    providerName: "SAP AI Core",
    id: "anthropic--claude-4.6-sonnet",
    name: "Claude Sonnet 4.6",
    contextWindow: 200_000,
    reasoning: true,
  },
  {
    value: "sap-ai-core/gpt-6.1",
    provider: "sap-ai-core",
    providerName: "SAP AI Core",
    id: "gpt-6.1",
    name: "GPT-6.1",
    contextWindow: 400_000,
    unavailable: "deployment not found",
  },
  {
    value: "google/gemini-2.5-pro",
    provider: "google",
    providerName: "Google",
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    contextWindow: 1_000_000,
    reasoning: true,
  },
];

function picker(
  overrides: Partial<Parameters<typeof ModelPicker>[0]> = {},
): HTMLElement {
  return render(
    <ModelPicker
      label="Model"
      models={models}
      selected=""
      favorites={[]}
      recent={[]}
      hidden={[]}
      onPick={() => undefined}
      onStar={() => undefined}
      onHide={() => undefined}
      {...overrides}
    >
      Pick
    </ModelPicker>,
  );
}

function names(page: HTMLElement): readonly string[] {
  return [...page.querySelectorAll('[role="option"]')].map(
    (option) => option.getAttribute("aria-label") ?? "",
  );
}

test("lists one provider at a time beside a rail of providers with their counts", () => {
  const page = picker({ selected: "google/gemini-2.5-pro" });

  click(byRole(page, "button", "Model"));

  expect(names(page)).toEqual(["Gemini 2.5 Pro"]);
  expect(page.textContent).toContain("1M");

  const rail = byRole(page, "group", "Providers");
  expect(rail.textContent).toContain("SAP AI Core2");

  click(
    [...rail.querySelectorAll("button")].find((button) =>
      button.textContent.startsWith("SAP AI Core"),
    ),
  );

  expect(names(page)).toEqual(["Claude Sonnet 4.6", "GPT-6.1"]);
  expect(page.textContent).toContain("anthropic--claude-4.6-sonnet");
  expect(page.textContent).toContain("200k");
});

test("shows a model that failed recently as unavailable, with why", () => {
  const page = picker({ selected: "sap-ai-core/gpt-6.1" });

  click(byRole(page, "button", "Model"));

  expect(byRole(page, "option", "GPT-6.1").textContent).toContain(
    "gpt-6.1 · last failed: deployment not found",
  );

  expect(byRole(page, "option", "GPT-6.1").textContent).toContain(
    "Unavailable",
  );
});

test("a search covers every provider, and “reasoning” finds the models that reason", () => {
  const picked: string[] = [];
  const page = picker({ onPick: (value) => picked.push(value) });

  click(byRole(page, "button", "Model"));

  const search = byRole(page, "combobox", "Model");
  type(search, "reasoning");

  expect(names(page)).toEqual(["Claude Sonnet 4.6", "Gemini 2.5 Pro"]);

  press(search, "ArrowDown");
  press(search, "Enter");

  expect(picked).toEqual(["google/gemini-2.5-pro"]);
});

test("stars a model, and Favorites and Recent list the person's own", () => {
  const starred: [string, boolean][] = [];

  const page = picker({
    favorites: ["google/gemini-2.5-pro"],
    recent: ["sap-ai-core/gpt-6.1", "google/gemini-2.5-pro"],
    onStar: (value, star) => starred.push([value, star]),
  });

  click(byRole(page, "button", "Model"));

  expect(names(page)).toEqual(["Gemini 2.5 Pro"]);

  click(byRole(page, "button", "Unstar gemini-2.5-pro"));

  const rail = byRole(page, "group", "Providers");

  click(
    [...rail.querySelectorAll("button")].find((button) =>
      button.textContent.startsWith("Recent"),
    ),
  );

  expect(names(page)).toEqual(["GPT-6.1", "Gemini 2.5 Pro"]);

  click(byRole(page, "button", "Star gpt-6.1"));

  expect(starred).toEqual([
    ["google/gemini-2.5-pro", false],
    ["sap-ai-core/gpt-6.1", true],
  ]);
});

test("hides models from the person's own pickers, except the one in use", () => {
  const hid: (readonly string[])[] = [];

  const page = picker({
    selected: "sap-ai-core/anthropic--claude-4.6-sonnet",
    hidden: ["sap-ai-core/gpt-6.1"],
    onHide: (hidden) => hid.push(hidden),
  });

  click(byRole(page, "button", "Model"));

  expect(names(page)).toEqual(["Claude Sonnet 4.6"]);

  click(byRole(page, "button", "Hide models…"));

  expect(names(page)).toEqual(["Claude Sonnet 4.6", "GPT-6.1"]);

  expect(byRole(page, "option", "GPT-6.1").getAttribute("aria-selected")).toBe(
    "false",
  );

  click(byRole(page, "option", "Claude Sonnet 4.6"));

  expect(hid).toEqual([
    ["sap-ai-core/gpt-6.1", "sap-ai-core/anthropic--claude-4.6-sonnet"],
  ]);
});

test("offers no model and a typed provider/id when asked to", () => {
  const picked: string[] = [];

  const page = picker({
    none: "Environment default",
    create: true,
    onPick: (value) => picked.push(value),
  });

  click(byRole(page, "button", "Model"));

  expect(names(page)[0]).toBe("Environment default");

  type(byRole(page, "combobox", "Model"), "local/llama");
  click(byRole(page, "option", "Use local/llama"));

  expect(picked).toEqual(["local/llama"]);
});

test("names the reasoning levels and keeps the login link for those who may log in", () => {
  const levels: string[] = [];
  let logins = 0;

  const page = picker({
    reasoning: {
      levels: ["off", "low", "high"].map((value) => ({ value, label: value })),
      value: "off",
      onChange: (level) => levels.push(level),
    },
    onLogin: () => {
      logins += 1;
    },
  });

  click(byRole(page, "button", "Model"));
  click(byRole(page, "button", "high"));
  click(byRole(page, "button", "Log in to a provider…"));

  expect(levels).toEqual(["high"]);
  expect(logins).toBe(1);
});

test("finds a model by its provider/id", () => {
  const page = picker();

  click(byRole(page, "button", "Model"));
  type(byRole(page, "combobox", "Model"), "google/gemini");

  expect(names(page)).toEqual(["Gemini 2.5 Pro"]);
});
