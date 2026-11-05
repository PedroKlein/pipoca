import { expect, test } from "bun:test";
import { Field } from "./field";
import { TextInput } from "./inputs";
import { byRole, render, withPage } from "./testing/render";

withPage();

test("a field labels its control and says why a value was refused", () => {
  const page = render(
    <Field label="Host" hint="Such as github.com" error="Not a host name">
      <TextInput />
    </Field>,
  );

  expect(byRole(page, "textbox").closest("label")?.textContent).toContain(
    "Host",
  );

  expect(byRole(page, "alert").textContent).toBe("Not a host name");
});
