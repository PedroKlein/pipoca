import { expect, test } from "bun:test";
import {
  type PluginTest,
  person,
  type TestPluginOptions,
  type TestSession,
  testPlugin,
} from "@pipoca/testing";
import type { ask } from "../plugin";
import { server } from "./server";
import type { Votes } from "./votes";

const people = [
  { id: "ana", name: "ana", admin: true },
  { id: "bo", name: "bo" },
  { id: "cy", name: "cy" },
];

async function started(
  o: TestPluginOptions<typeof ask> = {},
): Promise<PluginTest> {
  return testPlugin(server, { people, ...o });
}

async function teamWork(t: PluginTest): Promise<TestSession> {
  return t.session({ owner: "team", startedBy: "ana" });
}

async function opened(
  t: PluginTest,
  session: TestSession,
  by: string,
  vote: { question: string; options: string[]; minutes?: number },
): Promise<{ id: string; closesAt: string }> {
  return t.as(by).post(`sessions/${session.id}/votes`, vote);
}

async function openVotes(t: PluginTest, session: TestSession): Promise<Votes> {
  return t.as("ana").get(`sessions/${session.id}/votes`);
}

// What Pi reads with the next message a person sends it.
async function piReads(
  session: TestSession,
  text: string,
): Promise<string | undefined> {
  await session.send("ana", text);

  return session.delivered().at(-2)?.text;
}

test("Pi opens votes only in team work", async () => {
  await using t = await started();
  const own = await t.session({ owner: person("bo") });
  const team = await teamWork(t);

  expect(
    t.tool(
      "open_vote",
      { question: "Ship it?", options: ["Yes", "No"] },
      { session: own },
    ),
  ).rejects.toThrow("open_vote isn't offered in this Session");

  const answer = await t.tool(
    "open_vote",
    { question: "Ship it?", options: ["Yes", "No"] },
    { session: team },
  );

  const { votes } = await openVotes(t, team);

  expect(votes).toMatchObject([
    { question: "Ship it?", opener: `session:${team.id}` },
  ]);

  expect(answer).toEqual({
    text: `The vote is open until ${String(votes[0]?.closesAt)}.`,
    isError: false,
  });
});

test("the team votes, whoever started the work closes it, and Pi reads the result", async () => {
  await using t = await started();
  const session = await teamWork(t);

  const response = await t
    .as("bo")
    .raw("POST", `sessions/${session.id}/votes`, {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "Ship it today?",
        options: ["Ship", "Wait"],
      }),
    });

  expect(response.status).toBe(201);

  const { id } = (await response.json()) as { id: string };

  const pick = async (by: string, option: string): Promise<number> =>
    (
      await t.as(by).raw("PUT", `votes/${id}/pick`, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ option }),
      })
    ).status;

  expect(await pick("ana", "Ship")).toBe(200);
  expect(await pick("bo", "Wait")).toBe(200);
  expect(await pick("bo", "Ship")).toBe(200);
  expect(await pick("cy", "Later")).toBe(400);

  expect(await t.as("cy").get(`sessions/${session.id}/votes`)).toMatchObject({
    votes: [
      {
        picks: [
          { name: "ana", option: "Ship" },
          { name: "bo", option: "Ship" },
        ],
        mine: null,
        canClose: false,
      },
    ],
  });

  expect((await t.as("cy").raw("POST", `votes/${id}/close`)).status).toBe(403);

  expect((await t.as("ana").raw("POST", `votes/${id}/close`)).status).toBe(200);

  expect(await openVotes(t, session)).toEqual({ canOpen: true, votes: [] });
  expect(t.topics).toContain("ask.votes");

  expect(await piReads(session, "Go on")).toBe(
    [
      "The team talked since your last turn:",
      'Vote closed. "Ship it today?": Ship 2 (ana, bo), Wait 0. ana closed it.',
      "",
      "ana sends the next message.",
    ].join("\n"),
  );
});

test("a vote closes on time, at the minutes it was opened for", async () => {
  await using t = await started();
  const session = await teamWork(t);

  await opened(t, session, "ana", {
    question: "Lunch?",
    options: ["Yes", "No"],
    minutes: 1,
  });

  await t.clock.advance("59s");

  expect((await openVotes(t, session)).votes).toHaveLength(1);

  await t.clock.advance("1s");

  expect((await openVotes(t, session)).votes).toEqual([]);

  expect(await piReads(session, "Well?")).toContain(
    'Vote closed. "Lunch?": nobody voted. It closed on time.',
  );
});

test("a vote still closes on time after the server restarts", async () => {
  await using t = await started();
  const session = await teamWork(t);

  await opened(t, session, "ana", {
    question: "Lunch?",
    options: ["Yes", "No"],
    minutes: 5,
  });

  await t.restart();
  await t.clock.advance("5m");

  expect((await openVotes(t, session)).votes).toEqual([]);
});

test("a result that closes while the Session is offline reaches Pi once it is back", async () => {
  await using t = await started();
  const session = await teamWork(t);

  const { id } = await opened(t, session, "bo", {
    question: "Ship it?",
    options: ["Yes", "No"],
  });

  await session.online(false);
  await t.as("ana").post(`votes/${id}/close`);
  await session.online(true);

  expect(await piReads(session, "Go on")).toContain(
    'Vote closed. "Ship it?": nobody voted. ana closed it.',
  );
});

test("only a signed-in person picks", async () => {
  await using t = await started();
  const session = await teamWork(t);

  const { id } = await opened(t, session, "ana", {
    question: "Ship it?",
    options: ["Yes", "No"],
  });

  const response = await t.public().raw("PUT", `votes/${id}/pick`, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ option: "Yes" }),
  });

  expect(response.status).toBe(401);
  expect((await openVotes(t, session)).votes[0]?.picks).toEqual([]);
});

test("a vote stays open for the minutes the config gives, unless its opener says", async () => {
  await using t = await started({ config: { voteMinutes: 5 } });
  const session = await teamWork(t);

  await opened(t, session, "ana", {
    question: "Lunch?",
    options: ["Yes", "No"],
  });

  await opened(t, session, "ana", {
    question: "Dinner?",
    options: ["Yes", "No"],
    minutes: 30,
  });

  expect(
    t.store.all(
      "select question, (closes_at - opened_at) / 60000 as minutes from ask_votes order by opened_at",
    ),
  ).toEqual([
    { question: "Lunch?", minutes: 5 },
    { question: "Dinner?", minutes: 30 },
  ]);
});
