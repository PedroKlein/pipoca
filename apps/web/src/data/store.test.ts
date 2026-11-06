import { expect, test } from "bun:test";
import { createStore, type Watch } from "./store";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

function topics(): {
  readonly watch: Watch;
  readonly change: (topic: string) => void;
  readonly watched: () => readonly string[];
} {
  const watchers = new Set<{
    readonly topics: readonly string[];
    readonly onChange: () => void;
  }>();

  return {
    watch: (names, onChange) => {
      const watcher = { topics: names, onChange };
      watchers.add(watcher);

      return () => {
        watchers.delete(watcher);
      };
    },
    change: (topic) => {
      for (const watcher of watchers) {
        if (watcher.topics.includes(topic)) {
          watcher.onChange();
        }
      }
    },
    watched: () => [...watchers].flatMap((watcher) => watcher.topics),
  };
}

const settled = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("subscribers of one key share one request and one answer", async () => {
  const store = createStore(topics().watch);
  let loads = 0;

  const source = {
    load: async () => {
      loads += 1;

      return Promise.resolve(["a"]);
    },
  };

  const heard: string[] = [];
  store.subscribe("list", source, () => heard.push("one"));
  store.subscribe("list", source, () => heard.push("two"));

  expect(store.read("list")).toEqual({
    data: undefined,
    error: undefined,
    loading: true,
  });

  await settled();

  expect(loads).toBe(1);
  expect(heard).toEqual(["one", "two"]);

  expect(store.read("list")).toEqual({
    data: ["a"],
    error: undefined,
    loading: false,
  });
});

test("a change to a watched topic reads the key again", async () => {
  const changes = topics();
  const store = createStore(changes.watch);
  let version = 0;

  store.subscribe(
    "list",
    {
      load: async () => {
        version += 1;

        return Promise.resolve(version);
      },
      topics: ["people"],
    },
    () => undefined,
  );

  await settled();
  changes.change("sessions");
  await settled();

  expect(store.read("list").data).toBe(1);

  changes.change("people");
  await settled();

  expect(store.read("list").data).toBe(2);
});

test("invalidating a topic reads only subscribed keys that watch it", async () => {
  const store = createStore(topics().watch);
  const loads: string[] = [];

  const source = (key: string, watched: readonly string[]) => ({
    load: async () => {
      loads.push(key);

      return Promise.resolve(key);
    },
    topics: watched,
  });

  store.subscribe("people", source("people", ["people"]), () => undefined);
  store.subscribe("plugins", source("plugins", ["plugins"]), () => undefined);

  const leave = store.subscribe(
    "invites",
    source("invites", ["people"]),
    () => undefined,
  );

  await settled();
  leave();
  store.invalidate(["people"]);
  await settled();

  expect(loads).toEqual(["people", "plugins", "invites", "people"]);
});

test("the last subscriber leaving stops watching but keeps the answer", async () => {
  const changes = topics();
  const store = createStore(changes.watch);

  const leave = store.subscribe(
    "me",
    { load: async () => Promise.resolve("Bea"), topics: ["people"] },
    () => undefined,
  );

  expect(changes.watched()).toEqual(["people"]);

  await settled();
  leave();

  expect(changes.watched()).toEqual([]);
  expect(store.read("me").data).toBe("Bea");
});

test("a failed read keeps the last answer and reports the error", async () => {
  const store = createStore(topics().watch);
  let fail = false;

  store.subscribe(
    "list",
    {
      load: async () =>
        fail ? Promise.reject(new Error("offline")) : Promise.resolve([1]),
    },
    () => undefined,
  );

  await settled();
  fail = true;
  await store.reload("list");

  expect(store.read("list").data).toEqual([1]);
  expect(store.read("list").error?.message).toBe("offline");

  fail = false;
  await store.reload("list");

  expect(store.read("list").error).toBeUndefined();
});

test("an answer older than the last request is dropped", async () => {
  const store = createStore(topics().watch);
  const answers = [deferred<string>(), deferred<string>()];
  let call = 0;

  store.subscribe(
    "list",
    { load: async () => answers[call++]?.promise ?? "" },
    () => undefined,
  );

  const reloaded = store.reload("list");
  answers[1]?.resolve("new");
  await reloaded;
  answers[0]?.resolve("old");
  await settled();

  expect(store.read("list").data).toBe("new");
});

test("a seeded key is read without a request until it changes", async () => {
  const changes = topics();
  const store = createStore(changes.watch);
  let loads = 0;

  store.seed("auth", { user: "Bea" });

  store.subscribe(
    "auth",
    {
      load: async () => {
        loads += 1;

        return Promise.resolve({ user: "Cy" });
      },
      topics: ["people"],
    },
    () => undefined,
  );

  await settled();

  expect(loads).toBe(0);

  expect(store.read("auth")).toEqual({
    data: { user: "Bea" },
    error: undefined,
    loading: false,
  });

  changes.change("people");
  await settled();

  expect(store.read("auth").data).toEqual({ user: "Cy" });
});
