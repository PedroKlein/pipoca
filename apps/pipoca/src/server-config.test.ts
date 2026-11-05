import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protocolVersion, versionHeader } from "@pipoca/protocol";
import { closeServers, testServer } from "./testdata/harness";
import { runnerCredentials } from "./testdata/runners";

afterEach(closeServers);

const day = 24 * 60 * 60_000;

test("signs browsers out and refuses idle runner tokens after the days pipoca.json sets", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "pipoca-server-config-"));

  writeFileSync(
    join(configDir, "pipoca.json"),
    JSON.stringify({ server: { sessionDays: 2, runnerTokenDays: 3 } }),
  );

  const server = testServer({ configDir, runners: { pollWaitMs: 0 } });
  const runners = runnerCredentials(server, server.signedIn);
  const token = await runners.token("laptop");

  const signedIn = async (): Promise<boolean> =>
    ((await (await server.api("/api/auth")).json()) as { user: unknown })
      .user !== null;

  const polled = async (): Promise<number> =>
    (
      await fetch(new URL("/agent/work", server.url), {
        method: "POST",
        headers: {
          [versionHeader]: String(protocolVersion),
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ running: [], folders: [], models: [] }),
      })
    ).status;

  expect(await signedIn()).toBe(true);

  server.clock.advance(1.5 * day);
  expect(await signedIn()).toBe(true);
  expect(await polled()).toBe(200);

  server.clock.advance(1.5 * day);
  expect(await signedIn()).toBe(false);
  expect(await polled()).toBe(200);

  server.clock.advance(3.5 * day);
  expect(await polled()).toBe(401);
});
