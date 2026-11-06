import { expect, test } from "bun:test";
import { ChoiceCard, ChoiceTiles } from "./choice";
import { byRole, click, render, withPage } from "./testing/render";

withPage();

test("a choice card shows more once it is picked", () => {
  const page = render(
    <>
      <ChoiceCard checked title="This computer">
        <p>Folders</p>
      </ChoiceCard>
      <ChoiceCard checked={false} title="Another machine">
        <p>Command</p>
      </ChoiceCard>
    </>,
  );

  expect(page.textContent).toContain("Folders");
  expect(page.textContent).not.toContain("Command");
});

test("tiles are radios a form reads by name", () => {
  const picked: string[] = [];

  const page = render(
    <form>
      <ChoiceTiles
        label="Each Session runs"
        name="isolation"
        value="process"
        tiles={[
          { value: "process", title: "On the machine" },
          { value: "container", title: "In a container" },
        ]}
        onChange={(value) => {
          picked.push(value);
        }}
      />
    </form>,
  );

  const group = byRole(page, "radiogroup", "Each Session runs");
  const form = page.querySelector("form");

  expect(form && new FormData(form).get("isolation")).toBe("process");

  click(group.querySelector('input[value="container"]'));

  expect(picked).toEqual(["container"]);
});
