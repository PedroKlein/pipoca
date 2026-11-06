import { expect, test } from "bun:test";
import { testSession } from "@pipoca/testing";
import { session as part } from "./session";

const steps = [
  { text: "Read the code", status: "completed" },
  { text: "Write the fix", status: "in_progress" },
  { text: "Run the tests", status: "pending" },
];

test("an update_checklist call keeps the whole list in its result's details", async () => {
  const session = await testSession(part);

  expect(await session.tool("update_checklist", { items: steps })).toEqual({
    text: "Checklist updated: 1 of 3 done.",
    isError: false,
    details: { items: steps },
  });
});

test("an empty list clears the checklist", async () => {
  const session = await testSession(part);

  expect(await session.tool("update_checklist", { items: [] })).toEqual({
    text: "Checklist updated: 0 of 0 done.",
    isError: false,
    details: { items: [] },
  });
});

test("an item's status is pending, in_progress or completed", async () => {
  const session = await testSession(part);

  const answer = await session.tool("update_checklist", {
    items: [{ text: "Ship it", status: "shipped" }],
  });

  expect(answer.isError).toBe(true);
  expect(answer.details).toBeUndefined();
});
