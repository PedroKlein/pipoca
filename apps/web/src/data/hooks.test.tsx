import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactElement } from "react";

if (!GlobalRegistrator.isRegistered) {
  GlobalRegistrator.register();
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { seed, useAction, useMe, useQuery } = await import("./hooks");
const { request } = await import("./client");

type Listener = (event: { readonly data: string }) => void;

class FakeEventSource {
  static last: FakeEventSource | undefined;
  readyState = 1;
  private readonly listeners: Listener[] = [];

  constructor() {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") {
      this.listeners.push(listener);
    }
  }

  close(): void {
    this.readyState = 2;
  }

  send(topic: string): void {
    for (const listener of this.listeners) {
      listener({ data: JSON.stringify({ topic }) });
    }
  }
}

const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;
let requests: string[] = [];
let answer: (url: string, init?: RequestInit) => Response;
const roots: { unmount: () => void }[] = [];

beforeEach(() => {
  requests = [];
  answer = () => Response.json([]);

  globalThis.fetch = Object.assign(async (url: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${url}`);

    return Promise.resolve(answer(url, init));
  }, realFetch);

  Object.assign(globalThis, { EventSource: FakeEventSource });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });

  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  Object.assign(globalThis, { EventSource: realEventSource });
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function render(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);

  act(() => {
    root.render(element);
  });

  return container;
}

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function Names({ id }: { readonly id: string }): ReactElement {
  const { data, error, loading } = useQuery("people.list");

  if (loading) {
    return <p id={id}>loading</p>;
  }

  return (
    <p id={id}>{error ?? data?.map((person) => person.name).join(", ")}</p>
  );
}

const text = (page: HTMLElement, id: string): string | undefined =>
  page.querySelector(`#${id}`)?.textContent;

test("components reading one route share one request", async () => {
  answer = () => Response.json([{ id: "u1", name: "Bea" }]);

  const page = render(
    <>
      <Names id="one" />
      <Names id="two" />
    </>,
  );

  expect(text(page, "one")).toBe("loading");

  await settle();

  expect(requests).toEqual(["GET /api/people"]);
  expect(text(page, "one")).toBe("Bea");
  expect(text(page, "two")).toBe("Bea");
});

test("a change event for the route's topic reads it again", async () => {
  let name = "Bea";
  answer = () => Response.json([{ id: "u1", name }]);
  const page = render(<Names id="one" />);
  await settle();

  name = "Cy";
  FakeEventSource.last?.send("people");
  await settle(300);

  expect(text(page, "one")).toBe("Cy");
});

test("a failed read shows the server's message", async () => {
  answer = () =>
    Response.json(
      { error: "forbidden", message: "Admins only." },
      { status: 403 },
    );

  const page = render(<Names id="one" />);
  await settle();

  expect(text(page, "one")).toBe("Admins only.");
});

test("a request that changes a topic reads its routes again at once", async () => {
  let name = "Bea";
  answer = () => Response.json([{ id: "u1", name }]);
  const page = render(<Names id="one" />);
  await settle();

  name = "Cy";

  await act(async () => {
    await request("people.update", {
      params: { id: "u1" },
      body: { admin: true },
    });
  });

  await settle();

  expect(requests.at(-1)).toBe("GET /api/people");
  expect(text(page, "one")).toBe("Cy");
});

function Rename(): ReactElement {
  const rename = useAction(async (name: string) =>
    request("me.update", { body: { displayName: name } }),
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void rename.run("Cy");
        }}
      >
        {rename.pending ? "Saving" : "Save"}
      </button>
      <p id="error">{rename.error}</p>
    </div>
  );
}

test("an action says it is under way and what failed", async () => {
  let finish: (response: Response) => void = () => undefined;

  answer = () => new Response();

  globalThis.fetch = Object.assign(
    async () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
    realFetch,
  );

  const page = render(<Rename />);

  act(() => {
    page.querySelector("button")?.click();
  });

  expect(page.querySelector("button")?.textContent).toBe("Saving");

  finish(
    Response.json(
      { error: "invalid", message: "Names can't be empty." },
      { status: 422 },
    ),
  );

  await settle();

  expect(page.querySelector("button")?.textContent).toBe("Save");
  expect(text(page, "error")).toBe("Names can't be empty.");
});

function Who(): ReactElement {
  const me = useMe();

  return (
    <p id="me">
      {me.user.name} {String(me.admin)} {String(me.team)}
    </p>
  );
}

test("useMe reads who signed in from the page's first read", () => {
  seed("auth.status", {
    user: { id: "u1", name: "Bea", admin: true },
    setup: false,
    passwordLogin: true,
    solo: false,
    logins: [],
  });

  const page = render(<Who />);

  expect(text(page, "me")).toBe("Bea true true");
});
