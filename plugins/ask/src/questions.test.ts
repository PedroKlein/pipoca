import { expect, test } from "bun:test";
import {
  definePlugin,
  defineServer,
  type PostedQuestion,
  type Questions,
} from "@pipoca/plugins";
import type { Session } from "@pipoca/protocol";
import {
  type PluginTest,
  person,
  type TestSession,
  testPlugin,
  testSession,
  until,
} from "@pipoca/testing";
import { server } from "./server";
import { session as part } from "./session";
import type { WaitingQuestions } from "./waiting";

const people = [
  { id: "ana", name: "Ana" },
  { id: "bo", name: "Bo" },
  { id: "cy", name: "Cy" },
];

// A plugin that starts work from its events, such as routines, whose
// Sessions' questions wait past the turn and go back where the work came
// from.
const starter = definePlugin({
  id: "starter",
  title: "Starter",
  description: "Starts work whose questions wait.",
});

let questions: Questions | undefined;
const posted: PostedQuestion[] = [];

const starterServer = defineServer(starter, (context) => {
  questions = context.questions;

  context.provide.replies({
    post: async (question) => {
      posted.push(question);

      return Promise.resolve(true);
    },
  });
});

const approval = {
  id: "ship",
  prompt: "Ship it?",
  type: "single",
  options: [
    { value: "approve", label: "Approve" },
    { value: "reject", label: "Reject" },
  ],
};

async function started(): Promise<PluginTest> {
  posted.length = 0;

  return testPlugin(server, { people, plugins: [starterServer] });
}

function kept(): Questions {
  if (questions === undefined) {
    throw new Error("the starter didn't register");
  }

  return questions;
}

// Ana's work, whose questions are for Bo and wait an hour.
async function waitingWork(t: PluginTest): Promise<TestSession> {
  const session = await t.session({ owner: person("ana") });

  expect(
    kept().wait(session.id, {
      origin: { event: "starter.thing", fields: { thread: 7 } },
      owner: "ana",
      for: ["bo"],
      timeoutMs: 3_600_000,
    }),
  ).toBe(true);

  return session;
}

async function waiting(t: PluginTest, session: TestSession): Promise<boolean> {
  return (await t.as("ana").get<Session>(`/api/sessions/${session.id}`))
    .waiting;
}

async function asked(
  session: TestSession,
  input: Readonly<Record<string, unknown>>,
) {
  const pi = await testSession(part, { request: session.api.raw });

  return pi.tool("ask_user", input);
}

// What Pi was told last, once it was told this many things.
async function told(session: TestSession, count: number): Promise<string> {
  const delivered = await until(
    () => session.delivered(),
    (all) => all.length >= count,
  );

  return delivered.at(-1)?.text ?? "";
}

test("a question in work another plugin started ends the turn, posts where the work came from, and its answer comes as a message", async () => {
  await using t = await started();
  const session = await waitingWork(t);

  const answer = await asked(session, {
    questions: [{ ...approval, default: "reject" }],
  });

  const [open] = kept().open(session.id);
  const id = open?.id ?? "";
  const closesAt = new Date(t.clock.now() + 3_600_000).toISOString();

  expect(answer).toMatchObject({
    text: `Question ${id} waits for an answer until ${closesAt}. End your turn now. The answer comes as a message that names question ${id}.`,
    isError: false,
    endsTurn: true,
  });

  expect(await waiting(t, session)).toBe(true);

  await t.clock.advance(0);

  expect(posted).toMatchObject([
    {
      id,
      origin: { event: "starter.thing", fields: { thread: 7 } },
      text: `Pi is waiting for an answer.\n\n**Ship it?**\n- Approve\n- Reject\nIf nobody answers: Reject.\n\nIt waits until ${closesAt}.`,
      answerers: [{ id: "ana" }, { id: "bo" }],
    },
  ]);

  expect(kept().answer(id, { text: "approve", by: "bo-gh" })).toBe(true);
  expect(kept().answer(id, { text: "reject", by: "bo-gh" })).toBe(false);

  await session.online(true);

  expect(await told(session, 1)).toBe(
    `The answer to question ${id}, from bo-gh:\n\napprove`,
  );

  expect(await waiting(t, session)).toBe(false);
  expect(kept().open(session.id)).toEqual([]);
});

test("a question that times out takes its default, or says nobody answered", async () => {
  await using t = await started();
  const session = await waitingWork(t);

  await asked(session, { questions: [{ ...approval, default: "reject" }] });

  await asked(session, {
    questions: [{ id: "why", prompt: "Why?", type: "text" }],
    timeout: "2h",
  });

  const [first, second] = kept().open(session.id);
  await session.online(true);
  await t.clock.advance("1h");

  expect(await told(session, 1)).toBe(
    `Question ${first?.id ?? ""} timed out. Nobody answered in time, so take the default answers:\n- Q1: Reject`,
  );

  expect(await waiting(t, session)).toBe(true);
  await t.clock.advance("1h");

  expect(await told(session, 2)).toBe(
    `Question ${second?.id ?? ""} timed out. Nobody answered in time, and the questions have no default answer. If you can't go on without an answer, stop and say that you are blocked.`,
  );

  expect(await waiting(t, session)).toBe(false);
});

test("the people a question is for answer it in Pipoca, and others can't", async () => {
  await using t = await started();
  const session = await waitingWork(t);

  await asked(session, { questions: [approval] });

  const { questions: shown } = await t
    .as("ana")
    .get<WaitingQuestions>(`sessions/${session.id}/questions`);

  expect(shown).toMatchObject([{ mayAnswer: true }]);

  const id = shown[0]?.id ?? "";

  expect(
    t.as("cy").post(`questions/${id}/answer`, { text: "Approve" }),
  ).rejects.toThrow("only the people the question is for");

  await t.as("bo").post(`questions/${id}/answer`, { text: "Approve" });
  await session.online(true);

  expect(await told(session, 1)).toBe(
    `The answer to question ${id}, from Bo:\n\nApprove`,
  );

  expect(
    await t.as("ana").get<WaitingQuestions>(`sessions/${session.id}/questions`),
  ).toEqual({ questions: [] });
});

test("an open question still needs someone after a restart, and archiving the work closes it", async () => {
  await using t = await started();
  const session = await waitingWork(t);

  await asked(session, { questions: [approval] });
  await t.restart();

  expect(await waiting(t, session)).toBe(true);

  await session.archive();

  expect(await waiting(t, session)).toBe(false);
  expect(kept().open(session.id)).toEqual([]);
});

test("a default that is not one of the options is refused before anyone is asked", async () => {
  await using t = await started();
  const session = await waitingWork(t);

  expect(
    await asked(session, { questions: [{ ...approval, default: "maybe" }] }),
  ).toEqual({
    text: 'Question "ship" has default "maybe", which is not one of its options\' values.',
    isError: true,
  });

  expect(kept().open(session.id)).toEqual([]);
});

test("a question in a Session nobody said waits is asked there, holding the turn, and takes its default on time", async () => {
  await using t = await started();
  const session = await t.session({ owner: person("ana") });
  const fire: (() => Promise<void>)[] = [];

  const pi = await testSession(part, {
    request: session.api.raw,
    askQuestions: async (_questions, _explain, signal) =>
      new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(null);
        });
      }),
    timer: {
      after: (_ms, run) => {
        fire.push(run);

        return () => undefined;
      },
    },
  });

  const answer = pi.tool("ask_user", {
    questions: [{ ...approval, default: "reject" }],
    timeout: "30m",
  });

  await until(
    () => fire.length,
    (length) => length > 0,
  );

  await fire[0]?.();

  expect(await answer).toEqual({
    text: "Nobody answered in time, so take the default answers:\n- Q1: Reject",
    isError: false,
    details: expect.anything() as unknown,
  });

  expect(posted).toEqual([]);
  expect(kept().open(session.id)).toEqual([]);
});

test("without a plugin that keeps questions, nothing waits past the turn", async () => {
  await using t = await testPlugin(starterServer, { people });
  const session = await t.session({ owner: person("ana") });

  expect(kept().wait(session.id, { owner: "ana" })).toBe(false);
  expect(kept().open(session.id)).toEqual([]);
  expect(kept().answer("nope", { text: "yes", by: "Ana" })).toBe(false);
});
