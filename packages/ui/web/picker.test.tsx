import { expect, test } from "bun:test";
import { Picker } from "./picker";
import { byRole, click, press, render, type, withPage } from "./testing/render";

withPage();

const options = [
  { value: "sonnet", label: "Sonnet", group: "Anthropic" },
  { value: "opus", label: "Opus", group: "Anthropic" },
  { value: "gpt", label: "GPT", group: "OpenAI" },
];

test("opens a list from its chip and reports a pick", () => {
  const picked: (readonly string[])[] = [];

  const page = render(
    <Picker
      label="Model"
      options={options}
      selected={["sonnet"]}
      onChange={(values) => {
        picked.push(values);
      }}
    >
      Sonnet
    </Picker>,
  );

  const chip = byRole(page, "button", "Model");
  click(chip);

  expect(chip.getAttribute("aria-expanded")).toBe("true");

  click(byRole(page, "option", "Opus"));

  expect(picked).toEqual([["opus"]]);
});

test("a search keeps the options whose words match and Enter picks one", () => {
  const picked: (readonly string[])[] = [];

  const page = render(
    <Picker
      label="Model"
      placeholder="Search models"
      options={options}
      selected={[]}
      onChange={(values) => {
        picked.push(values);
      }}
    >
      Pick a model
    </Picker>,
  );

  click(byRole(page, "button", "Model"));

  const search = byRole(page, "combobox", "Model");
  type(search, "openai");

  expect(
    [...page.querySelectorAll('[role="option"]')].map(
      (option) => option.textContent,
    ),
  ).toEqual(["GPT"]);

  press(search, "Enter");

  expect(picked).toEqual([["gpt"]]);
});
