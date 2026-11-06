import { expect, test } from "bun:test";
import { Config, definePlugin, event, Type } from "@pipoca/plugins";

test("a definition reads back as written", () => {
  const greeted = event({
    title: "Greeted",
    fields: Type.Object({ name: Type.String() }),
  });

  const plugin = definePlugin({
    id: "greeter",
    title: "Greeter",
    description: "Says hello",
    config: Config.object({
      greeting: Config.string({ title: "Greeting", default: "Hello" }),
    }),
    events: { greeted },
  });

  expect(plugin.id).toBe("greeter");
  expect(plugin.events.greeted).toBe(greeted);
});

test("refuses an id that isn't lowercase letters, digits and hyphens", () => {
  for (const id of ["Greeter", "1greeter", "greeter_bot", ""]) {
    expect(() =>
      definePlugin({ id, title: "Greeter", description: "Says hello" }),
    ).toThrow(`plugin id ${id} must be`);
  }
});
