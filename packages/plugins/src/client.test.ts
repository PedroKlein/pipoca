import { expect, test } from "bun:test";
import { pluginClient } from "./client";

test("a path can't climb out of the plugin's routes or cut off the rest of the address", async () => {
  const asked: string[] = [];

  const api = pluginClient(
    { id: "artifacts" },
    {
      fetch: async (url) => {
        asked.push(url);

        return Promise.resolve(Response.json({}));
      },
    },
  );

  await api.get("artifacts/a1", { opened: 1 });

  for (const path of [
    "artifacts/../projects/p1/fresh",
    "artifacts/./a1",
    "artifacts/..",
    "artifacts/a1/download#",
    "artifacts/%2e%2e/projects",
  ]) {
    expect(api.post(path)).rejects.toThrow("isn't a route");
  }

  expect(asked).toEqual(["/api/ext/artifacts/artifacts/a1?opened=1"]);
});
