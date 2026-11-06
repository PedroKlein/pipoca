import { expect, test } from "bun:test";
import type { AskQuestions } from "@pipoca/plugins";
import { testSession } from "@pipoca/testing";
import { session as part } from "./session";

async function askedDisk(
  number: Record<string, number>,
): Promise<{ asked: boolean; text: string; isError: boolean }> {
  let asked = false;

  const session = await testSession(part, {
    askQuestions: async () => {
      asked = true;

      return Promise.resolve(null);
    },
  });

  const { text, isError } = await session.tool("ask_user", {
    questions: [
      { id: "disk", prompt: "How much disk?", type: "number", ...number },
    ],
  });

  return { asked, text, isError };
}

test("refuses a number question whose step is not positive", async () => {
  for (const step of [0, -1]) {
    expect(await askedDisk({ min: 1, max: 10, step })).toEqual({
      asked: false,
      text: `Question "disk" has step ${String(step)}; step must be above 0.`,
      isError: true,
    });
  }
});

test("refuses a number question whose min is above its max", async () => {
  expect(await askedDisk({ min: 10, max: 1 })).toEqual({
    asked: false,
    text: 'Question "disk" has min 10 above max 1.',
    isError: true,
  });
});

test("asks a number question with a valid range", async () => {
  expect(await askedDisk({ min: 1, max: 10, step: 0.5 })).toMatchObject({
    asked: true,
    isError: false,
  });
});

test("asks the named person in team work and tells Pi who answered for them", async () => {
  const asked: (string | undefined)[] = [];

  const askQuestions: AskQuestions = async (
    _questions,
    _explain,
    _signal,
    person,
  ) => {
    asked.push(person);

    return Promise.resolve({
      answers: [{ id: "ship", type: "text", text: "Friday" }],
      note: null,
      by: "Bo",
    });
  };

  const session = await testSession(part, { askQuestions });

  const answer = await session.tool("ask_user", {
    for: "Ana",
    questions: [{ id: "ship", prompt: "When do we ship?", type: "text" }],
  });

  expect(asked).toEqual(["Ana"]);

  expect(answer).toMatchObject({
    text: "Bo, answering for Ana, answers:\n- Q1: Friday",
    isError: false,
  });
});
