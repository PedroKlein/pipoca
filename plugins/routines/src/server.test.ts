import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRoute, StartRequest } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  fakeUser,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import { routinesSchema } from "./engine";
import { routines } from "./server";

test("a team Session can't make routines, which would run as its starter", async () => {
  let route: PluginRoute | undefined;

  routines.register(
    fakeContext({
      store: memoryStore(routinesSchema),
      config: {
        get: () => undefined,
        set: () => undefined,
        lockedIn: () => undefined,
        dir: await mkdtemp(join(tmpdir(), "routines-")),
      },
      tools: { register: () => undefined },
      auth: { ...fakeContext().auth, handlePublic: () => undefined },
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
    }),
  );

  const response = await route?.(
    new Request("http://routines/routines"),
    "routines",
    {
      kind: "session",
      session: fakeSession({ startedBy: "ana", ownedBy: "team" }),
      actor: "session:session-1",
    },
  );

  expect(response?.status).toBe(403);
});

test("anyone on the team makes a team routine, whose runs start as team work", async () => {
  let route: PluginRoute | undefined;
  const started: StartRequest[] = [];

  routines.register(
    fakeContext({
      store: memoryStore(routinesSchema),
      config: {
        get: () => undefined,
        set: () => undefined,
        lockedIn: () => undefined,
        dir: await mkdtemp(join(tmpdir(), "routines-")),
      },
      tools: { register: () => undefined },
      auth: { ...fakeContext().auth, handlePublic: () => undefined },
      environments: {
        ...fakeContext().environments,
        list: () => [],
      },
      sessions: {
        ...fakeContext().sessions,
        start: (request) => {
          started.push(request);

          return fakeSession({ id: `run-${String(started.length)}` });
        },
      },
      routes: {
        handle: (handler) => {
          route = served(handler);
        },
      },
    }),
  );

  const call = async (
    path: string,
    person: string,
    init?: RequestInit,
  ): Promise<Response | undefined> =>
    route?.(
      new Request(`http://routines/${path}`, init),
      path,
      fakeUser({ id: person }),
    );

  const routine = {
    title: "Triage new issues",
    triggers: [{ cron: "0 9 * * 1-5", timeZone: "Europe/Berlin" }],
    run: {
      prompt: "Label the new issues",
      workspace: {
        kind: "clone",
        repository: "https://git.example.com/app.git",
      },
      profile: "team-work",
    },
  };

  const saved = await call("team-routines/triage", "ana", {
    method: "PUT",
    body: JSON.stringify(routine),
  });

  expect(saved?.status).toBe(200);

  expect(await (await call("team-routines", "bo"))?.json()).toMatchObject([
    { name: "triage", title: "Triage new issues" },
  ]);

  expect(await (await call("routines", "bo"))?.json()).toEqual([]);
  expect(await (await call("routines", "ana"))?.json()).toEqual([]);

  const ran = await call("team-routines/triage/run", "bo", { method: "POST" });

  expect(ran?.status).toBe(201);

  expect(started).toMatchObject([
    { actor: "plugin:routines", team: true, profile: "team-work" },
  ]);

  const into = await call("team-routines/into", "ana", {
    method: "PUT",
    body: JSON.stringify({
      ...routine,
      run: { prompt: "Check in", session: "someones-session" },
    }),
  });

  expect(into?.status).toBe(400);
});
