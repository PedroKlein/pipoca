import { expect, test } from "bun:test";
import { modelName, modelRefOf } from "./index";

test("reads provider/id, keeping slashes the model id has", () => {
  expect(modelRefOf("openrouter/meta/llama-4")).toEqual({
    provider: "openrouter",
    id: "meta/llama-4",
  });

  expect(modelName({ provider: "openrouter", id: "meta/llama-4" })).toBe(
    "openrouter/meta/llama-4",
  );

  for (const refused of ["", "faux", "/faux", "faux/"]) {
    expect(modelRefOf(refused)).toBeUndefined();
  }
});
