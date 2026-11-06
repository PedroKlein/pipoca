import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  defineServer,
  type Schedule,
  type ServerContext,
} from "@pipoca/plugins";
import type { ServerPart } from "@pipoca/plugins/host";
import { until } from "@pipoca/testing/until";
import { closeServers, testClock, testServer } from "./testdata/harness";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

let root: string;
let database: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pipoca-schedules-")));
  database = join(root, "server.db");
});

afterEach(async () => {
  await closeServers();
  await rm(root, { recursive: true, force: true });
});

function timers(
  register: (context: ServerContext) => void,
  schema?: string,
  migrations: readonly string[] = [],
): ServerPart {
  return defineServer(
    definePlugin({
      id: "timers",
      title: "Timers",
      description: "",
      ...(schema !== undefined && { schema, migrations }),
    }),
    register,
  );
}

test("fires an at once, at its time", async () => {
  const fired: unknown[] = [];
  let schedule: Schedule | undefined;

  const server = testServer({
    builtIns: false,
    servers: [
      timers((context) => {
        schedule = context.schedule;

        context.schedule.on("ping:", (payload, key) => {
          fired.push({ key, payload });
        });

        context.schedule.at("ping:1", context.clock.now() + hour, { n: 1 });
      }),
    ],
  });

  expect(schedule?.pending("ping:")).toMatchObject([
    { key: "ping:1", payload: { n: 1 } },
  ]);

  await server.clock.advance(hour - minute);

  expect(fired).toEqual([]);

  await server.clock.advance(minute);

  expect(fired).toEqual([{ key: "ping:1", payload: { n: 1 } }]);

  await server.clock.advance(day);

  expect(fired).toHaveLength(1);
  expect(schedule?.pending("")).toEqual([]);
});

test("fires what came due while the server was down once it starts", async () => {
  const fired: string[] = [];
  const clock = testClock();

  const plugin = (scheduling: boolean): ServerPart =>
    timers(({ schedule }) => {
      schedule.on("", (_payload, key) => {
        fired.push(key);
      });

      if (scheduling) {
        schedule.at("wake", clock.now() + hour);
      }
    });

  await testServer({
    database,
    clock,
    builtIns: false,
    servers: [plugin(true)],
  }).close();

  await clock.advance(2 * hour);

  expect(fired).toEqual([]);

  testServer({ database, clock, builtIns: false, servers: [plugin(false)] });

  expect(
    await until(
      () => fired,
      (each) => each.length > 0,
    ),
  ).toEqual(["wake"]);
});

test("fires an at 40 days out at its time, not before", async () => {
  const fired: string[] = [];

  const server = testServer({
    builtIns: false,
    servers: [
      timers(({ schedule, clock }) => {
        schedule.on("far", (_payload, key) => {
          fired.push(key);
        });

        schedule.at("far", clock.now() + 40 * day);
      }),
    ],
  });

  await server.clock.advance(39 * day);

  expect(fired).toEqual([]);

  await server.clock.advance(day);

  expect(fired).toEqual(["far"]);
});

test("reads an interval again after each run", async () => {
  let interval = minute;
  let runs = 0;

  const server = testServer({
    builtIns: false,
    servers: [
      timers(({ schedule }) => {
        schedule.every(
          "tick",
          () => interval,
          () => {
            runs += 1;
          },
        );
      }),
    ],
  });

  interval = hour;
  await server.clock.advance(minute);

  expect(runs).toBe(1);

  await server.clock.advance(minute);

  expect(runs).toBe(1);

  await server.clock.advance(hour);

  expect(runs).toBe(2);
});

test("starts no run of an interval while the last one runs", async () => {
  let starts = 0;
  let release = (): void => undefined;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const server = testServer({
    builtIns: false,
    servers: [
      timers(({ schedule }) => {
        schedule.every("slow", minute, async () => {
          starts += 1;

          if (starts === 1) {
            await held;
          }
        });
      }),
    ],
  });

  const first = server.clock.advance(minute);
  await server.clock.advance(10 * minute);

  expect(starts).toBe(1);

  release();
  await first;
  await server.clock.advance(minute);

  expect(starts).toBe(2);
});

test("retries a failing at after 1, 5 and 30 minutes, then drops it", async () => {
  let tries = 0;
  let schedule: Schedule | undefined;

  const server = testServer({
    builtIns: false,
    servers: [
      timers((context) => {
        schedule = context.schedule;

        context.schedule.on("flaky", () => {
          tries += 1;

          throw new Error("down");
        });

        context.schedule.at("flaky", context.clock.now());
      }),
    ],
  });

  await server.clock.advance(0);

  expect(tries).toBe(1);

  await server.clock.advance(minute);

  expect(tries).toBe(2);

  await server.clock.advance(4 * minute);

  expect(tries).toBe(2);

  await server.clock.advance(minute);

  expect(tries).toBe(3);

  await server.clock.advance(30 * minute);

  expect(tries).toBe(4);

  await server.clock.advance(day);

  expect(tries).toBe(4);
  expect(schedule?.pending("")).toEqual([]);

  expect(
    server.logs.filter((line) =>
      line.startsWith("schedule dropped after its retries"),
    ),
  ).toHaveLength(1);
});

test("keeps the schedules of a plugin that is off until it is on again", async () => {
  const fired: string[] = [];
  const clock = testClock();

  const plugin = (scheduling: boolean): ServerPart =>
    timers(({ schedule }) => {
      schedule.on("", (_payload, key) => {
        fired.push(key);
      });

      if (scheduling) {
        schedule.at("later", clock.now() + hour);
      }
    });

  await testServer({
    database,
    clock,
    builtIns: false,
    servers: [plugin(true)],
  }).close();

  const off = testServer({
    database,
    clock,
    builtIns: false,
    servers: [plugin(false)],
    disabledPlugins: ["timers"],
  });

  await off.clock.advance(2 * hour);
  await off.close();

  expect(fired).toEqual([]);

  testServer({ database, clock, builtIns: false, servers: [plugin(false)] });

  expect(
    await until(
      () => fired,
      (each) => each.length > 0,
    ),
  ).toEqual(["later"]);
});

test("resetting a plugin's data drops its schedules", async () => {
  const fired: string[] = [];
  const clock = testClock();
  let schedule: Schedule | undefined;

  const plugin = (
    migrations: readonly string[],
    scheduling: boolean,
  ): ServerPart =>
    timers(
      (context) => {
        schedule = context.schedule;

        context.schedule.on("", (_payload, key) => {
          fired.push(key);
        });

        if (scheduling) {
          context.store.run("insert into timers_a (a) values (null)");
          context.schedule.at("later", clock.now() + hour);
        }
      },
      "create table timers_a (a text) strict",
      migrations,
    );

  const copied = [
    "create table timers_b (b text not null) strict; insert into timers_b select a from timers_a",
  ];

  const before = testServer({
    database,
    clock,
    builtIns: false,
    servers: [plugin([], true)],
  });

  const cookie = await before.signedIn();
  await before.close();

  const server = testServer({
    database,
    clock,
    cookie,
    builtIns: false,
    servers: [plugin(copied, false)],
  });

  await server.clock.advance(2 * hour);

  expect(fired).toEqual([]);

  const reset = await server.api("/api/plugins/timers/data", {
    method: "DELETE",
  });

  expect(reset.status).toBe(200);
  await server.close();

  const after = testServer({
    database,
    clock,
    cookie,
    builtIns: false,
    servers: [plugin(copied, false)],
  });

  expect(schedule?.pending("")).toEqual([]);

  await after.clock.advance(day);

  expect(fired).toEqual([]);
});
