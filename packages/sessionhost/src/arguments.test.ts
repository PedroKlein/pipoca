import { expect, test } from "bun:test";
import { repairArguments } from "./arguments";

const schema = {
  type: "object",
  required: ["path", "query", "questions"],
  properties: {
    path: { type: "string" },
    query: { type: "string" },
    id: { type: "string", minLength: 1 },
    for: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, default: { type: "string" } },
      },
    },
  },
};

test("leaves out optional fields a model sent empty, at any depth", () => {
  expect(
    repairArguments(
      {
        path: "report.md",
        query: "",
        id: "",
        for: null,
        questions: [{ id: "q1", default: "" }],
      },
      schema,
    ),
  ).toEqual({ path: "report.md", query: "", questions: [{ id: "q1" }] });
});

test("keeps optional fields that hold a value", () => {
  const args = {
    path: "report.md",
    query: "x",
    id: "a1",
    questions: [{ id: "q1", default: "yes" }],
  };

  expect(repairArguments(args, schema)).toEqual(args);
});
