import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginRoute } from "@pipoca/plugins";
import {
  fakeContext,
  fakeSession,
  memoryStore,
  served,
} from "@pipoca/plugins/testing";
import { routines } from "./server";

test("a team Session can't make routines, which would run as its starter", async () => {
  let route: PluginRoute | undefined;

  routines.register(
    fakeContext({
      store: memoryStore(),
      config: {
        get: () => undefined,
        set: () => undefined,
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
