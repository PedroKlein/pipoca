import { expect, test } from "bun:test";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { SessionCloud } from "@pipoca/plugins";
import { ask } from "./session";

async function askUser(
  number: Record<string, number>,
): Promise<{ asked: boolean; result: Promise<unknown> }> {
  const unused = (): never => {
    throw new Error("not used by ask_user");
  };

  const state = { asked: false };

  const cloud: SessionCloud = {
    publish: unused,
    askQuestions: async () => {
      state.asked = true;

      return Promise.resolve(null);
    },
    askPermission: unused,
    checkouts: [],
    settings: {},
    request: unused,
    log: () => undefined,
    startChild: unused,
  };

  const tools = (await ask.tools?.(cloud)) ?? [];
  const tool = tools.find(({ name }) => name === "ask_user");
  if (tool === undefined) {
    throw new Error("ask offered no ask_user tool");
  }

  const result = tool.execute(
    "call-1",
    {
      questions: [
        { id: "disk", prompt: "How much disk?", type: "number", ...number },
      ],
    },
    undefined,
    undefined,
    {} as ExtensionToolContext,
  );

  await result.catch(() => undefined);

  return { asked: state.asked, result };
}

test("refuses a number question whose step is not positive", async () => {
  for (const step of [0, -1]) {
    const { asked, result } = await askUser({ min: 1, max: 10, step });

    expect(result).rejects.toThrow(
      `Question "disk" has step ${String(step)}; step must be above 0.`,
    );

    expect(asked).toBe(false);
  }
});

test("refuses a number question whose min is above its max", async () => {
  const { asked, result } = await askUser({ min: 10, max: 1 });

  expect(result).rejects.toThrow('Question "disk" has min 10 above max 1.');

  expect(asked).toBe(false);
});

test("asks a number question with a valid range", async () => {
  const { asked } = await askUser({ min: 1, max: 10, step: 0.5 });

  expect(asked).toBe(true);
});

test("asks the named person in team work and tells Pi who answered for them", async () => {
  const unused = (): never => {
    throw new Error("not used by ask_user");
  };

  const asked: (string | undefined)[] = [];

  const cloud: SessionCloud = {
    publish: unused,
    askQuestions: async (_questions, _explain, _signal, person) => {
      asked.push(person);

      return Promise.resolve({
        answers: [{ id: "ship", type: "text", text: "Friday" }],
        note: null,
        by: "Bo",
      });
    },
    askPermission: unused,
    checkouts: [],
    settings: {},
    request: unused,
    log: () => undefined,
    startChild: unused,
  };

  const tool = ((await ask.tools?.(cloud)) ?? []).find(
    ({ name }) => name === "ask_user",
  );

  const result = await tool?.execute(
    "call-1",
    {
      for: "Ana",
      questions: [{ id: "ship", prompt: "When do we ship?", type: "text" }],
    },
    undefined,
    undefined,
    {} as ExtensionToolContext,
  );

  expect(asked).toEqual(["Ana"]);

  expect(result?.content).toEqual([
    {
      type: "text",
      text: "Bo, answering for Ana, answers:\n- Q1: Friday",
    },
  ]);
});
